/**
 * auditLiveVsCanonical — the inverse auditor's PURE core, driven entirely by
 * fixtures with NO database. This proves testability: computeUnexplained, the
 * ledger validators, the normalizers and the extractors all run offline. It
 * imports only guard-free modules (lib/liveVsCanonicalCore, explainedLiveObjects,
 * and a type-only handle on rlsDispositions), so the read-only production guard
 * never enters the import graph.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildModel,
  computeUnexplained,
  normalizeArgTypes,
  normalizePredicate,
  normalizeRoles,
  extractConstraints,
  extractExtensions,
  extractFunctionSignatures,
  extractPolicyPredicates,
  extractColumnGrants,
  extractEnumValues,
  extractConstraintBackedIndexes,
  blankSqlComments,
  deriveImplicitConstraints,
} from "../scripts/lib/liveVsCanonicalCore.js";
import type {
  LiveInventory,
  Model,
  CiSurface,
  UnexplainedInput,
} from "../scripts/lib/liveVsCanonicalCore.js";
import {
  EXPLAINED_LIVE_OBJECTS,
  validateLedgerShape,
} from "../scripts/explainedLiveObjects.js";
import type { ExplainedEntry } from "../scripts/explainedLiveObjects.js";
import type { RlsDisposition } from "../scripts/rlsDispositions.js";

// Dispositions may carry a deep_verifier the base RlsDisposition type does not
// declare (REVIEWED_EXEMPT requires one); widen for the fixtures.
type Disp = RlsDisposition & { deep_verifier?: string };
type DispMap = Record<string, Disp>;

const baseCi: CiSurface = {
  packageScripts: new Set(["audit:schema", "audit:live-unexplained"]),
  runAllChecksText: "",
  workflowText: "",
};

function makeLive(over: Partial<LiveInventory> = {}): LiveInventory {
  return {
    pgVersionNum: 150000,
    relations: new Map(),
    columns: new Set(),
    functions: new Set(),
    indexes: new Set(),
    policies: new Map(),
    enums: new Set(),
    enumValues: new Set(),
    triggers: new Set(),
    rlsEnabled: new Set(),
    policyCountByTable: new Map(),
    tableGrants: new Map(),
    columnGrants: new Map(),
    routineGrants: new Map(),
    constraints: new Set(),
    extensions: new Set(),
    ...over,
  };
}

function makeModel(over: Partial<Model> = {}): Model {
  return {
    relations: new Set(),
    columns: new Set(),
    functions: new Set(),
    indexes: new Set(),
    policies: new Map(),
    enums: new Set(),
    enumValues: new Set(),
    triggers: new Set(),
    rlsClaimTables: new Set(),
    tableGrants: new Map(),
    columnGrants: new Map(),
    routineGrants: new Map(),
    constraints: new Set(),
    extensions: new Set(),
    ledgerKeys: new Set(),
    ...over,
  };
}

function run(
  over: Partial<UnexplainedInput> & {
    model: Model;
    live: LiveInventory;
    dispositions: DispMap;
  },
) {
  return computeUnexplained({
    ledger: over.ledger ?? [],
    ledgerShapeProblems: over.ledgerShapeProblems ?? [],
    ci: over.ci ?? baseCi,
    ...over,
  });
}

const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);
const keysFor = (r: { findings: { code: string; key: string }[] }, code: string) =>
  r.findings.filter((f) => f.code === code).map((f) => f.key);

// ─────────────────────────────────────────────────────────────────────────────

describe("computeUnexplained — exit contract", () => {
  it("a fully-explained snapshot is exit 0 with no findings", () => {
    const live = makeLive({
      relations: new Map([["foo", "r"]]),
      rlsEnabled: new Set(["foo"]),
      policyCountByTable: new Map([["foo", 1]]),
      extensions: new Set(["pgcrypto"]),
    });
    const model = makeModel({
      relations: new Set(["foo"]),
      rlsClaimTables: new Set(["foo"]),
      ledgerKeys: new Set(["extension:pgcrypto"]),
    });
    const ledger: ExplainedEntry[] = [
      {
        key: "extension:pgcrypto",
        kind: "extension",
        provenance: "x:1",
        disposition: "LEGACY_PROVENANCE",
        reason: "seeded",
        reviewed_on: "2026-08-19",
      },
    ];
    const r = run({ model, live, dispositions: { foo: { class: "RLS_REQUIRED", policyCount: 1 } }, ledger });
    assert.deepEqual(r.findings, []);
    assert.equal(r.exitCode, 0);
  });

  it("an unexplained live object is UNEXPLAINED_LIVE, exit 1", () => {
    const live = makeLive({
      relations: new Map([["foo", "r"]]),
      indexes: new Set(["idx_orphan"]),
    });
    const model = makeModel({ relations: new Set(["foo"]), rlsClaimTables: new Set(["foo"]) });
    const r = run({ model, live, dispositions: { foo: { class: "RLS_REQUIRED", policyCount: 1 } } });
    assert.ok(codes(r).includes("UNEXPLAINED_LIVE"));
    assert.deepEqual(keysFor(r, "UNEXPLAINED_LIVE"), ["idx_orphan"]);
    assert.equal(r.exitCode, 1);
  });

  it("empty live census is exit 2 even when findings exist (precedence 2 > 1)", () => {
    const live = makeLive(); // relations empty
    const model = makeModel();
    const r = run({
      model,
      live,
      dispositions: {},
      ledgerShapeProblems: [{ entryIndex: 0, key: "k", code: "C", detail: "d" }],
    });
    assert.ok(r.findings.length > 0, "there is a LEDGER_SHAPE_INVALID finding");
    assert.equal(r.exitCode, 2);
  });

  it("empty disposition manifest is exit 2 (vacuity) even with a live census", () => {
    const live = makeLive({
      relations: new Map([["foo", "r"]]),
      rlsEnabled: new Set(["foo"]),
      policyCountByTable: new Map([["foo", 1]]),
    });
    const model = makeModel({
      relations: new Set(["foo"]),
      rlsClaimTables: new Set(["foo"]),
    });
    const r = run({ model, live, dispositions: {} });
    assert.equal(r.exitCode, 2);
  });
});

describe("computeUnexplained — EXCESS_PRIVILEGE (table AND column grants)", () => {
  it("flags any privilege live holds beyond the model, on both grant kinds", () => {
    const live = makeLive({
      relations: new Map([["foo", "r"]]),
      tableGrants: new Map([["foo.anon", new Set(["select", "insert"])]]),
      columnGrants: new Map([["foo.c.anon", new Set(["update"])]]),
    });
    const model = makeModel({
      relations: new Set(["foo"]),
      rlsClaimTables: new Set(["foo"]),
      tableGrants: new Map([["foo.anon", new Set(["select"])]]),
      columnGrants: new Map(),
    });
    const r = run({ model, live, dispositions: { foo: { class: "RLS_REQUIRED", policyCount: 1 } } });
    const excess = r.findings.filter((f) => f.code === "EXCESS_PRIVILEGE");
    assert.equal(excess.length, 2);
    assert.ok(excess.some((f) => f.kind === "grant" && f.detail.includes("insert")));
    assert.ok(excess.some((f) => f.kind === "columngrant" && f.detail.includes("update")));
    assert.equal(r.exitCode, 1);
  });
});

describe("computeUnexplained — grant coverage (Postgres semantics)", () => {
  it("GRANT ALL in the model covers every expanded live privilege", () => {
    const live = makeLive({
      relations: new Map([["foo", "r"]]),
      tableGrants: new Map([
        ["foo.service_role", new Set(["select", "insert", "update", "delete", "truncate", "references", "trigger"])],
      ]),
    });
    const model = makeModel({
      relations: new Set(["foo"]),
      rlsClaimTables: new Set(["foo"]),
      tableGrants: new Map([["foo.service_role", new Set(["all"])]]),
    });
    const r = run({ model, live, dispositions: { foo: { class: "RLS_REQUIRED", policyCount: 1 } } });
    assert.equal(r.findings.filter((f) => f.code === "EXCESS_PRIVILEGE").length, 0);
  });

  it("a TABLE grant covers the column grants Postgres derives from it", () => {
    const live = makeLive({
      relations: new Map([["foo", "r"]]),
      tableGrants: new Map([["foo.anon", new Set(["select"])]]),
      columnGrants: new Map([
        ["foo.a.anon", new Set(["select"])],
        ["foo.b.anon", new Set(["select"])],
      ]),
    });
    const model = makeModel({
      relations: new Set(["foo"]),
      rlsClaimTables: new Set(["foo"]),
      tableGrants: new Map([["foo.anon", new Set(["select"])]]),
    });
    const r = run({ model, live, dispositions: { foo: { class: "RLS_REQUIRED", policyCount: 1 } } });
    assert.equal(r.findings.filter((f) => f.code === "EXCESS_PRIVILEGE").length, 0);
  });

  it("ignores owner/internal-role grants but still flags anon excess", () => {
    const live = makeLive({
      relations: new Map([["foo", "r"]]),
      tableGrants: new Map([
        ["foo.postgres", new Set(["select", "insert", "update", "delete"])],
        ["foo.service_role", new Set(["select", "insert"])],
        ["foo.anon", new Set(["select", "delete"])],
      ]),
      columnGrants: new Map([["foo.c.postgres", new Set(["update"])]]),
    });
    const model = makeModel({
      relations: new Set(["foo"]),
      rlsClaimTables: new Set(["foo"]),
      tableGrants: new Map([["foo.anon", new Set(["select"])]]),
    });
    const r = run({ model, live, dispositions: { foo: { class: "RLS_REQUIRED", policyCount: 1 } } });
    const ex = r.findings.filter((f) => f.code === "EXCESS_PRIVILEGE");
    // postgres + service_role grants ignored; only anon 'delete' surfaces.
    assert.equal(ex.length, 1);
    assert.ok(ex[0].key === "foo.anon" && ex[0].detail.includes("delete"));
  });

  it("still flags a TRUE column excess the table grant does not cover", () => {
    const live = makeLive({
      relations: new Map([["foo", "r"]]),
      tableGrants: new Map([["foo.anon", new Set(["select"])]]),
      columnGrants: new Map([["foo.a.anon", new Set(["update"])]]),
    });
    const model = makeModel({
      relations: new Set(["foo"]),
      rlsClaimTables: new Set(["foo"]),
      tableGrants: new Map([["foo.anon", new Set(["select"])]]),
    });
    const r = run({ model, live, dispositions: { foo: { class: "RLS_REQUIRED", policyCount: 1 } } });
    const ex = r.findings.filter((f) => f.code === "EXCESS_PRIVILEGE");
    assert.equal(ex.length, 1);
    assert.ok(ex[0].detail.includes("update"));
  });
});

describe("normalizers strip public. (pg_dump over-qualifies; pg_get_expr does not)", () => {
  it("normalizePredicate drops public. schema qualification", () => {
    assert.equal(
      normalizePredicate("(x = public.can_see(a) AND y::public.my_enum = 'z')"),
      "x = can_see(a) and y::my_enum = 'z'",
    );
  });
  it("normalizeArgTypes drops public. from enum/array types", () => {
    assert.equal(normalizeArgTypes("uuid, public.event_role_type[]"), "uuid,event_role_type[]");
  });
});

describe("extractEnumValues — multi-line CREATE TYPE AS ENUM", () => {
  it("reads enum labels from the CREATE TYPE body pg_dump emits", () => {
    const sql = "CREATE TYPE public.appeal_state AS ENUM (\n    'pending',\n    'approved',\n    'denied'\n);";
    const got = [...extractEnumValues(sql)].sort();
    assert.deepEqual(got, ["appeal_state.approved", "appeal_state.denied", "appeal_state.pending"]);
  });
});

describe("extractConstraintBackedIndexes — PK/UNIQUE constraints", () => {
  it("returns the constraint-named index for PK and UNIQUE, not CHECK/FK", () => {
    const sql = [
      "ALTER TABLE ONLY public.foo ADD CONSTRAINT foo_pkey PRIMARY KEY (id);",
      "ALTER TABLE ONLY public.foo ADD CONSTRAINT foo_x_key UNIQUE (x);",
      "ALTER TABLE ONLY public.foo ADD CONSTRAINT foo_chk CHECK (x > 0);",
      "ALTER TABLE ONLY public.bar ADD CONSTRAINT bar_fk FOREIGN KEY (fid) REFERENCES public.foo(id);",
    ].join("\n");
    const got = [...extractConstraintBackedIndexes(sql)].sort();
    assert.deepEqual(got, ["foo_pkey", "foo_x_key"]);
  });
});

describe("computeUnexplained — view columns are not audited", () => {
  it("excludes columns of view/matview relations (model has none by design)", () => {
    const live = makeLive({
      relations: new Map([["foo", "r"], ["v_bar", "v"]]),
      rlsEnabled: new Set(["foo"]),
      policyCountByTable: new Map([["foo", 1]]),
      columns: new Set(["foo.a", "v_bar.x"]),
    });
    const model = makeModel({
      relations: new Set(["foo", "v_bar"]),
      rlsClaimTables: new Set(["foo"]),
      columns: new Set(["foo.a"]),
    });
    const r = run({ model, live, dispositions: { foo: { class: "RLS_REQUIRED", policyCount: 1 } } });
    assert.deepEqual(
      r.findings.filter((f) => f.code === "UNEXPLAINED_LIVE" && f.kind === "column"),
      [],
    );
  });
});

describe("computeUnexplained — POLICY_PREDICATE_DRIFT", () => {
  it("ignores paren/role-order differences and flags real drift", () => {
    const live = makeLive({
      relations: new Map([["foo", "r"]]),
      policies: new Map([
        ["public.foo.p", { using: "(a = b)", withCheck: null, roles: ["authenticated", "anon"], cmd: "select" }],
        ["public.foo.q", { using: "(x = 1)", withCheck: null, roles: ["anon"], cmd: "select" }],
      ]),
    });
    const model = makeModel({
      relations: new Set(["foo"]),
      rlsClaimTables: new Set(["foo"]),
      policies: new Map([
        ["public.foo.p", { using: "((a = b))", withCheck: null, roles: ["anon", "authenticated"] }],
        ["public.foo.q", { using: "(y = 2)", withCheck: null, roles: ["anon"] }],
      ]),
    });
    const r = run({ model, live, dispositions: { foo: { class: "RLS_REQUIRED", policyCount: 2 } } });
    assert.deepEqual(keysFor(r, "POLICY_PREDICATE_DRIFT"), ["public.foo.q"]);
    assert.equal(r.exitCode, 1);
  });
});

describe("computeUnexplained — RLS disposition axes", () => {
  it("DISPOSITION_MISSING covers the FULL live public r/p set (post_event_links property)", () => {
    // The table has an RLS claim (in rlsClaimTables) yet no disposition record —
    // exactly the case a MINUS-scoped coverage check would miss.
    const live = makeLive({
      relations: new Map([
        ["foo", "r"],
        ["post_event_links", "r"],
      ]),
    });
    const model = makeModel({
      relations: new Set(["foo", "post_event_links"]),
      rlsClaimTables: new Set(["foo", "post_event_links"]),
    });
    const r = run({ model, live, dispositions: { foo: { class: "RLS_REQUIRED", policyCount: 1 } } });
    assert.deepEqual(keysFor(r, "DISPOSITION_MISSING"), ["post_event_links"]);
    assert.equal(r.exitCode, 1);
  });

  it("DISPOSITION_STALE flags a record naming no live table", () => {
    const live = makeLive({ relations: new Map([["foo", "r"]]) });
    const model = makeModel({ relations: new Set(["foo"]), rlsClaimTables: new Set(["foo"]) });
    const r = run({
      model,
      live,
      dispositions: {
        foo: { class: "RLS_REQUIRED", policyCount: 1 },
        ghost: { class: "RLS_REQUIRED", policyCount: 1 },
      },
    });
    assert.deepEqual(keysFor(r, "DISPOSITION_STALE"), ["ghost"]);
    assert.equal(r.exitCode, 1);
  });

  it("DISPOSITION_UNRESOLVED flags a NEEDS_REVIEW record", () => {
    const live = makeLive({ relations: new Map([["foo", "r"]]) });
    const model = makeModel({ relations: new Set(["foo"]), rlsClaimTables: new Set(["foo"]) });
    const r = run({ model, live, dispositions: { foo: { class: "NEEDS_REVIEW", policyCount: 0 } } });
    assert.ok(codes(r).includes("DISPOSITION_UNRESOLVED"));
    assert.equal(r.exitCode, 1);
  });

  it("REVIEWED_EXEMPT requires reason/reviewer/date AND a wired deep_verifier", () => {
    const live = makeLive({ relations: new Map([["a", "r"], ["b", "r"], ["c", "r"]]) });
    const model = makeModel({
      relations: new Set(["a", "b", "c"]),
      rlsClaimTables: new Set(["a", "b", "c"]), // skip 4c so 4b is isolated
    });
    const dispositions: DispMap = {
      // missing reviewer + date -> metadata finding; also no deep_verifier
      a: { class: "REVIEWED_EXEMPT", policyCount: 0, reason: "r", reviewer: "", date: "" },
      // full metadata but deep_verifier not a package.json script
      b: { class: "REVIEWED_EXEMPT", policyCount: 0, reason: "r", reviewer: "rev", date: "2026-01-01", deep_verifier: "nope" },
      // full metadata + wired verifier -> clean
      c: { class: "REVIEWED_EXEMPT", policyCount: 0, reason: "r", reviewer: "rev", date: "2026-01-01", deep_verifier: "audit:schema" },
    };
    const r = run({ model, live, dispositions });
    const metaKeys = keysFor(r, "DISPOSITION_METADATA");
    assert.ok(metaKeys.includes("a"));
    assert.ok(metaKeys.includes("b"));
    assert.ok(!metaKeys.includes("c"));
    assert.equal(r.exitCode, 1);
  });

  it("class consistency runs only on the complement of rlsClaimTables", () => {
    // 'claimed' is a claimed table the forward auditor owns — not re-judged.
    // 'comp' is in the complement and IS judged against live facts.
    const live = makeLive({
      relations: new Map([["claimed", "r"], ["comp", "r"]]),
      rlsEnabled: new Set(), // both RLS-off live
      policyCountByTable: new Map(),
    });
    const model = makeModel({
      relations: new Set(["claimed", "comp"]),
      rlsClaimTables: new Set(["claimed"]),
    });
    const dispositions: DispMap = {
      claimed: { class: "RLS_REQUIRED", policyCount: 1 },
      comp: { class: "RLS_REQUIRED", policyCount: 1 },
    };
    const r = run({ model, live, dispositions });
    const mism = keysFor(r, "DISPOSITION_CLASS_MISMATCH");
    assert.deepEqual(mism, ["comp"]);
    assert.equal(r.exitCode, 1);
  });
});

describe("computeUnexplained — ledger self-consistency", () => {
  it("STALE_LEDGER_ENTRY flags a ledger key not seen live", () => {
    const live = makeLive({ relations: new Map([["foo", "r"]]) });
    const model = makeModel({
      relations: new Set(["foo"]),
      rlsClaimTables: new Set(["foo"]),
      ledgerKeys: new Set(["extension:ghostext"]),
    });
    const ledger: ExplainedEntry[] = [
      {
        key: "extension:ghostext",
        kind: "extension",
        provenance: "x:1",
        disposition: "LEGACY_PROVENANCE",
        reason: "r",
        reviewed_on: "2026-01-01",
      },
    ];
    const r = run({ model, live, dispositions: { foo: { class: "RLS_REQUIRED", policyCount: 1 } }, ledger });
    assert.deepEqual(keysFor(r, "STALE_LEDGER_ENTRY"), ["extension:ghostext"]);
    assert.equal(r.exitCode, 1);
  });

  it("VERIFIER_NOT_WIRED flags a HARDENED_INVARIANT whose verifier is not a package.json script", () => {
    const live = makeLive({ relations: new Map([["foo", "r"]]), extensions: new Set(["hv"]) });
    const model = makeModel({
      relations: new Set(["foo"]),
      rlsClaimTables: new Set(["foo"]),
      ledgerKeys: new Set(["extension:hv"]),
    });
    const ledger: ExplainedEntry[] = [
      {
        key: "extension:hv",
        kind: "extension",
        provenance: "x:1",
        disposition: "HARDENED_INVARIANT",
        reason: "r",
        reviewed_on: "2026-01-01",
        deep_verifier: "not-wired",
      },
    ];
    const r = run({ model, live, dispositions: { foo: { class: "RLS_REQUIRED", policyCount: 1 } }, ledger });
    assert.deepEqual(keysFor(r, "VERIFIER_NOT_WIRED"), ["extension:hv"]);
    assert.equal(r.exitCode, 1);
  });

  it("LEDGER_SHAPE_INVALID problems surface as exit-1 findings, not exit 2", () => {
    const live = makeLive({ relations: new Map([["foo", "r"]]) });
    const model = makeModel({ relations: new Set(["foo"]), rlsClaimTables: new Set(["foo"]) });
    const r = run({
      model,
      live,
      dispositions: { foo: { class: "RLS_REQUIRED", policyCount: 1 } },
      ledgerShapeProblems: [{ entryIndex: 0, key: "extension:x", code: "EMPTY_REASON", detail: "no reason" }],
    });
    assert.ok(codes(r).includes("LEDGER_SHAPE_INVALID"));
    assert.equal(r.exitCode, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("normalizers — golden cases", () => {
  it("normalizeArgTypes strips names, defaults, modes; folds synonyms; keeps arrays/multiword", () => {
    assert.equal(normalizeArgTypes("target_user_id uuid, new_role text"), "uuid,text");
    assert.equal(normalizeArgTypes("p_paths text[]"), "text[]");
    assert.equal(normalizeArgTypes("col timestamp with time zone"), "timestamp with time zone");
    assert.equal(normalizeArgTypes("handle character varying"), "character varying");
    assert.equal(normalizeArgTypes(""), "");
    assert.equal(normalizeArgTypes("p integer DEFAULT 5"), "integer");
    assert.equal(normalizeArgTypes("uuid, text"), "uuid,text"); // name-less (live identity form)
    assert.equal(normalizeArgTypes("roles public.event_role_type[]"), "event_role_type[]"); // public. stripped
    assert.equal(normalizeArgTypes("x timestamptz"), "timestamp with time zone");
    assert.equal(normalizeArgTypes("n int"), "integer");
    assert.equal(normalizeArgTypes("p double precision"), "double precision");
    assert.equal(normalizeArgTypes("VARIADIC vals text[]"), "text[]");
  });

  it("normalizePredicate collapses whitespace and redundant outer parens", () => {
    assert.equal(normalizePredicate("((a = b))"), "a = b");
    assert.equal(normalizePredicate("  A   =  B "), "a = b");
    assert.equal(normalizePredicate("(a = b) AND (c = d)"), "(a = b) and (c = d)");
    assert.equal(normalizePredicate(null), null);
  });

  it("normalizeRoles sorts, lower-cases and de-duplicates", () => {
    assert.deepEqual(normalizeRoles(["Authenticated", "anon", "anon"]), ["anon", "authenticated"]);
  });
});

describe("extractors — golden cases", () => {
  it("extractPolicyPredicates defaults an unqualified target to schema 'public'", () => {
    const m = extractPolicyPredicates("CREATE POLICY p ON events FOR SELECT USING ((a = b));");
    assert.ok(m.has("public.events.p"));
    assert.equal(normalizePredicate(m.get("public.events.p")!.using), "a = b");
  });

  it("extractPolicyPredicates keeps an explicit schema and parses roles + with check", () => {
    const m = extractPolicyPredicates(
      "CREATE POLICY sel ON storage.objects FOR INSERT TO authenticated, anon WITH CHECK ((bucket_id = 'x'));",
    );
    const e = m.get("storage.objects.sel")!;
    assert.deepEqual(normalizeRoles(e.roles), ["anon", "authenticated"]);
    assert.equal(normalizePredicate(e.withCheck), "bucket_id = 'x'");
  });

  it("extractColumnGrants parses the paren column-grant syntax parseMigration misses", () => {
    const m = extractColumnGrants("GRANT SELECT(id),UPDATE(id) ON TABLE public.t TO authenticated;");
    assert.deepEqual([...(m.get("t.id.authenticated") ?? [])].sort(), ["select", "update"]);
  });

  it("extractConstraints reads ALTER TABLE ... ADD CONSTRAINT keyed by table.conname", () => {
    const s = "ALTER TABLE ONLY public.foo\n    ADD CONSTRAINT foo_pkey PRIMARY KEY (id);";
    assert.ok(extractConstraints(s).has("foo.foo_pkey"));
  });

  // ───────────────────────────────────────────────────────────────────────────
  // THE TWO GAPS THAT KEPT THIS AUDIT RED FOR 23 CONSECUTIVE SCHEDULED RUNS.
  //
  // Every fixture above is written the way a fixture is written: no prose, no
  // unnamed constraints. The real migrations are the opposite, and the whole
  // suite stayed green while the job found 672 unexplained constraints on
  // every run. The cases below are transcribed from the migrations that
  // produced those findings, prose and all, so a regression shows up here
  // instead of at 03:47 the next morning.
  // ───────────────────────────────────────────────────────────────────────────

  it("blankSqlComments blanks a line comment without moving any offset", () => {
    const sql = "CREATE TABLE t ( -- it's here\n  id uuid\n);";
    const out = blankSqlComments(sql);
    assert.equal(out.length, sql.length, "offsets must be preserved");
    assert.ok(!out.includes("it's here"));
    assert.ok(out.includes("CREATE TABLE t ("));
    assert.ok(out.includes("id uuid"));
  });

  it("blankSqlComments leaves string literals, quoted identifiers and $$ bodies alone", () => {
    assert.ok(blankSqlComments("SELECT '-- not a comment';").includes("-- not a comment"));
    assert.ok(blankSqlComments('SELECT "a--b" FROM t;').includes("a--b"));
    const fn = "CREATE FUNCTION f() AS $$ begin -- real comment\n  return 1; end $$;";
    assert.ok(blankSqlComments(fn).includes("-- real comment"), "a $$ body is data, not SQL to clean");
  });

  it("blankSqlComments blanks nested block comments", () => {
    const out = blankSqlComments("CREATE /* a /* b */ c */ TABLE t (id uuid);");
    assert.ok(!out.includes("a"), "the whole nested comment must go");
    assert.ok(out.includes("TABLE t (id uuid)"));
  });

  it("extractConstraints survives an apostrophe in a comment inside the table body", () => {
    // Transcribed from 2860_layover_airport_truth_and_events.sql. The
    // apostrophe in "0127's vocabularies" (line 165) opened a string literal
    // that ran into the next real CHECK literal, reversing the polarity of
    // every quote after it; the body ended unbalanced, balancedParenBody
    // returned null, and EVERY constraint of this table left the model.
    const sql = `
CREATE TABLE IF NOT EXISTS airport_fact_observations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Stored rather than computed, for consistency with 0127's vocabularies.
  observed_at   timestamptz NOT NULL,
  expires_at    timestamptz NOT NULL,
  CONSTRAINT airport_fact_observations_ttl_forward CHECK (expires_at > observed_at)
);`;
    const got = extractConstraints(sql);
    assert.ok(
      got.has("airport_fact_observations.airport_fact_observations_ttl_forward"),
      "the explicitly named constraint must survive the comment",
    );
    assert.ok(
      got.has("airport_fact_observations.airport_fact_observations_pkey"),
      "and so must the generated primary-key name",
    );
  });

  it("deriveImplicitConstraints names the constraints a hand-written CREATE TABLE leaves unnamed", () => {
    // Transcribed from 2992_layover_decision_record_and_operational_tables.sql.
    // Not one of these seven constraints is named in the migration; all seven
    // are named in pg_constraint.
    const sql = `
CREATE TABLE IF NOT EXISTS layover_checkpoints (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID        NOT NULL REFERENCES layover_sessions(id) ON DELETE CASCADE,
  checkpoint_type TEXT        NOT NULL CHECK (checkpoint_type IN ('SECURITY','GATE')),
  source          TEXT        NOT NULL DEFAULT 'TRAVELLER' CHECK (source IN ('TRAVELLER','DEVICE')),
  dedup_key       TEXT        NOT NULL CHECK (length(dedup_key) BETWEEN 1 AND 200),
  UNIQUE (session_id, dedup_key)
);`;
    const { constraints, indexes } = deriveImplicitConstraints(sql);
    for (const expected of [
      "layover_checkpoints.layover_checkpoints_pkey",
      "layover_checkpoints.layover_checkpoints_session_id_fkey",
      "layover_checkpoints.layover_checkpoints_checkpoint_type_check",
      "layover_checkpoints.layover_checkpoints_source_check",
      "layover_checkpoints.layover_checkpoints_dedup_key_check",
      "layover_checkpoints.layover_checkpoints_session_id_dedup_key_key",
    ]) {
      assert.ok(constraints.has(expected), `missing derived constraint ${expected}`);
    }
    // PK and UNIQUE also create an index that pg_indexes lists live.
    assert.ok(indexes.has("layover_checkpoints_pkey"));
    assert.ok(indexes.has("layover_checkpoints_session_id_dedup_key_key"));
    assert.ok(
      extractConstraintBackedIndexes(sql).has("layover_checkpoints_pkey"),
      "the index inventory must carry them too",
    );
  });

  it("deriveImplicitConstraints does not read a CHECK literal as a keyword", () => {
    // 'primary' and 'unique' appear only inside the IN-list; neither declares
    // anything, and a naive keyword scan would invent two constraints here.
    const sql =
      "CREATE TABLE t (\n  kind text CHECK (kind IN ('primary','unique','check')),\n  id uuid\n);";
    const { constraints } = deriveImplicitConstraints(sql);
    assert.deepEqual([...constraints].sort(), ["t.t_kind_check"]);
  });

  it("deriveImplicitConstraints suffixes a second unnamed CHECK on one column, as Postgres does", () => {
    const sql = "CREATE TABLE t (n integer CHECK (n >= 0) CHECK (n <= 10));";
    const { constraints } = deriveImplicitConstraints(sql);
    assert.deepEqual([...constraints].sort(), ["t.t_n_check", "t.t_n_check1"]);
  });

  it("deriveImplicitConstraints names constraints arriving by ALTER TABLE ADD COLUMN", () => {
    // 2952 (media_assets.purge_status) and 2996 (compass_conversations.trip_id):
    // a constraint on a BASELINE table, declared with no name, by ADD COLUMN.
    const check = deriveImplicitConstraints(
      "ALTER TABLE public.media_assets\n  ADD COLUMN IF NOT EXISTS purge_status TEXT NOT NULL DEFAULT 'not_requested'\n    CHECK (purge_status IN ('not_requested','pending'));",
    );
    assert.ok(check.constraints.has("media_assets.media_assets_purge_status_check"));
    const fk = deriveImplicitConstraints(
      "ALTER TABLE public.compass_conversations\n  ADD COLUMN IF NOT EXISTS trip_id UUID NULL REFERENCES public.trips(id) ON DELETE SET NULL;",
    );
    assert.ok(fk.constraints.has("compass_conversations.compass_conversations_trip_id_fkey"));
  });

  it("deriveImplicitConstraints reads CREATE CONSTRAINT TRIGGER as a pg_constraint row", () => {
    // 3387's cee_transaction_balances is contype 't': one object in two
    // inventories, and the constraint inventory was blind to it.
    const sql =
      "CREATE CONSTRAINT TRIGGER cee_transaction_balances\n  AFTER INSERT ON public.creator_earning_entries\n  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION f();";
    assert.ok(
      deriveImplicitConstraints(sql).constraints.has(
        "creator_earning_entries.cee_transaction_balances",
      ),
    );
  });

  it("deriveImplicitConstraints does not read a CTAS or a partition clause as a column list", () => {
    assert.equal(deriveImplicitConstraints("CREATE TABLE t AS SELECT max(id) FROM u;").constraints.size, 0);
    assert.equal(
      deriveImplicitConstraints("CREATE TABLE t PARTITION OF u FOR VALUES IN ('a');").constraints.size,
      0,
    );
  });

  it("deriveImplicitConstraints emits nothing rather than a guess when the name would not fit", () => {
    const col = "c".repeat(70);
    const sql = `CREATE TABLE t (${col} integer CHECK (${col} >= 0));`;
    const { constraints, skippedTooLong } = deriveImplicitConstraints(sql);
    assert.equal(constraints.size, 0, "a name over 63 bytes must not be guessed at");
    assert.equal(skippedTooLong.length, 1);
  });

  it("normalizeArgTypes folds the bare type aliases a migration writes", () => {
    // 2297: `p_suppression_rate FLOAT DEFAULT 0.3` is stored as float8 and
    // printed by pg_get_function_identity_arguments as 'double precision'. The
    // model said 'float', so a function the repository declares read as
    // UNEXPLAINED_LIVE on every run.
    assert.equal(
      normalizeArgTypes("p_item_id TEXT, p_viewer_id TEXT, p_threshold INTEGER DEFAULT 100, p_suppression_rate FLOAT DEFAULT 0.3"),
      "text,text,integer,double precision",
    );
    assert.equal(normalizeArgTypes("a timestamp, b time, c char"), "timestamp without time zone,time without time zone,character");
    // The live spelling is already canonical and must survive untouched.
    assert.equal(normalizeArgTypes("timestamp with time zone, double precision"), "timestamp with time zone,double precision");
  });

  it("extractExtensions reads CREATE EXTENSION (baseline has none, canonical may add)", () => {
    assert.ok(extractExtensions("CREATE EXTENSION IF NOT EXISTS pgcrypto;").has("pgcrypto"));
    assert.equal(extractExtensions("select 1;").size, 0);
  });

  it("extractFunctionSignatures keys by proname -> normalized identity args", () => {
    const m = extractFunctionSignatures("CREATE FUNCTION public.f(a uuid, b text) RETURNS void AS $$ begin end $$;");
    assert.deepEqual([...(m.get("f") ?? [])], ["uuid,text"]);
  });
});

describe("validateLedgerShape — unit cases", () => {
  it("flags vacuity", () => {
    const p = validateLedgerShape([]);
    assert.equal(p.length, 1);
    assert.equal(p[0].code, "LEDGER_VACUOUS");
  });

  it("flags a duplicate key", () => {
    const dup: ExplainedEntry[] = [
      { key: "extension:x", kind: "extension", provenance: "a:1", disposition: "LEGACY_PROVENANCE", reason: "r", reviewed_on: "2026-01-01" },
      { key: "extension:x", kind: "extension", provenance: "a:1", disposition: "LEGACY_PROVENANCE", reason: "r", reviewed_on: "2026-01-01" },
    ];
    assert.ok(validateLedgerShape(dup).some((x) => x.code === "DUPLICATE_KEY"));
  });

  it("flags HARDENED_INVARIANT without a deep_verifier", () => {
    const e: ExplainedEntry[] = [
      { key: "extension:x", kind: "extension", provenance: "a:1", disposition: "HARDENED_INVARIANT", reason: "r", reviewed_on: "2026-01-01" },
    ];
    assert.ok(validateLedgerShape(e).some((x) => x.code === "HARDENED_WITHOUT_VERIFIER"));
  });

  it("flags a corrective_migration naming a file below the '2100' band", () => {
    const e: ExplainedEntry[] = [
      { key: "relation:x", kind: "relation", provenance: "a:1", disposition: "CORRECTIVE_MIGRATION_PENDING", reason: "r", reviewed_on: "2026-01-01", corrective_migration: "2095_x.sql" },
    ];
    assert.ok(validateLedgerShape(e).some((x) => x.code === "CORRECTIVE_BELOW_BAND"));
  });

  it("the committed EXPLAINED_LIVE_OBJECTS seed is structurally valid", () => {
    assert.deepEqual(validateLedgerShape(EXPLAINED_LIVE_OBJECTS), []);
  });
});

describe("buildModel — injected parsers, empty canonical band", () => {
  it("folds baseline tables, a view, an rls claim and the ledger keys into the model", () => {
    const baselineSql = [
      "CREATE TABLE public.foo (id uuid);",
      "CREATE VIEW public.foo_view AS SELECT 1;",
    ].join("\n");
    const baselineTables = new Map([
      ["foo", { table: "foo", rlsEnabled: true, policyCount: 1 }],
    ]);
    const ledger: ExplainedEntry[] = [
      { key: "extension:pgcrypto", kind: "extension", provenance: "a:1", disposition: "LEGACY_PROVENANCE", reason: "r", reviewed_on: "2026-01-01" },
    ];
    // Minimal parseMig stub: recognizes the CREATE VIEW so the view lands in relations.
    const parseMig = (sql: string) => {
      const out: { kind: string; key: string; label: string }[] = [];
      const vm = /create\s+view\s+public\.(\w+)/i.exec(sql);
      if (vm) out.push({ kind: "view", key: `view:${vm[1]}`, label: "" });
      return out;
    };
    const model = buildModel({ baselineSql, baselineTables, canonicalSqls: [], ledger, parseMig });
    assert.ok(model.relations.has("foo"));
    assert.ok(model.relations.has("foo_view"));
    assert.ok(model.rlsClaimTables.has("foo"));
    assert.ok(model.ledgerKeys.has("extension:pgcrypto"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Model gaps found by run 37608414616 (2026-10-07, main 116ca4541f): 1,001
// findings, of which these three model defects produced 106 EXCESS_PRIVILEGE,
// 17 UNEXPLAINED_LIVE and 113 POLICY_PREDICATE_DRIFT for objects the chain
// plainly declares. Each case below is transcribed from the migration that
// produced the finding. The real-tree cases read the committed baseline and
// migrations with a no-op parseMig stub, so the guarded forward parser never
// enters this file's import graph.
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync as mgReaddir, readFileSync as mgRead } from "node:fs";
import { dirname as mgDirname, join as mgJoin, resolve as mgResolve } from "node:path";
import { fileURLToPath as mgFileUrl } from "node:url";
import {
  CHAIN_START_PREFIX,
  expandForeachLiteralLoops,
  extractGrants,
  partitionByChainStart,
} from "../scripts/lib/liveVsCanonicalCore.js";

const MG_API = mgResolve(mgDirname(mgFileUrl(import.meta.url)), "..", "..");
const MG_MIGRATIONS = mgJoin(MG_API, "src", "migrations");
const mgMig = (f: string) => mgRead(mgJoin(MG_MIGRATIONS, f), "utf8");
const noParse = () => [] as { kind: string; key: string; label: string }[];

describe("extractGrants — the GRANT shapes parseMigration cannot read", () => {
  it("credits every target of a multi-table GRANT (2780:113, 2794:134)", () => {
    const g = extractGrants(
      "GRANT SELECT ON public.trip_subgroups, public.trip_subgroup_members TO authenticated;",
    ).tableGrants;
    assert.deepEqual([...g.keys()].sort(), ["trip_subgroup_members.authenticated", "trip_subgroups.authenticated"]);
    assert.deepEqual([...g.get("trip_subgroups.authenticated")!], ["select"]);
  });

  it("credits every grantee, for table AND column grants (extractColumnGrants read the first only)", () => {
    const { tableGrants, columnGrants } = extractGrants(
      "GRANT SELECT, INSERT ON TABLE public.t TO anon, authenticated;\n" +
        "GRANT SELECT (a, b), UPDATE (b) ON TABLE public.t TO anon, authenticated;",
    );
    assert.deepEqual([...tableGrants.get("t.anon")!].sort(), ["insert", "select"]);
    assert.deepEqual([...tableGrants.get("t.authenticated")!].sort(), ["insert", "select"]);
    assert.deepEqual([...columnGrants.get("t.b.authenticated")!].sort(), ["select", "update"]);
    assert.deepEqual([...extractColumnGrants("GRANT SELECT (a) ON public.t TO anon, authenticated;").keys()].sort(), [
      "t.a.anon",
      "t.a.authenticated",
    ]);
  });

  it("maps ALL [PRIVILEGES] to 'all' and keeps WITH GRANT OPTION out of the grantee list", () => {
    const g = extractGrants("GRANT ALL PRIVILEGES ON public.t TO service_role WITH GRANT OPTION;").tableGrants;
    assert.deepEqual([...g.get("t.service_role")!], ["all"]);
  });

  it("reads no grant from a non-table target, another schema, a format placeholder, or COMMENT prose", () => {
    const sql = [
      "GRANT EXECUTE ON FUNCTION public.f(uuid) TO authenticated;",
      "GRANT USAGE ON SEQUENCE public.s TO anon;",
      "GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;",
      "GRANT SELECT ON storage.objects TO anon;",
      "DO $$ BEGIN EXECUTE format('GRANT SELECT ON public.%I TO authenticated', 'x'); END $$;",
      "COMMENT ON TABLE public.t IS 'clients never grant select on t to anon';",
    ].join("\n");
    const { tableGrants, columnGrants } = extractGrants(sql);
    assert.equal(tableGrants.size, 0, [...tableGrants.keys()].join(","));
    assert.equal(columnGrants.size, 0);
  });

  it("reads a GRANT inside an EXECUTE literal (a DO-block grant is a real grant)", () => {
    const g = extractGrants("DO $$ BEGIN EXECUTE 'GRANT SELECT (catalog_id) ON TABLE public.user_stamps TO anon, authenticated'; END $$;");
    assert.ok(g.columnGrants.has("user_stamps.catalog_id.authenticated"));
  });
});

describe("expandForeachLiteralLoops — loop-issued DDL, exactly or not at all", () => {
  it("writes out a FOREACH-literal loop element-major (2762's shape)", () => {
    const out = expandForeachLiteralLoops(`DO $grants$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['trip_goals','trip_risks'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (authz.is_trip_crew(trip_id))',
      t || '_select_crew', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END
$grants$;`);
    assert.deepEqual(out.split("\n"), [
      "ALTER TABLE public.trip_goals ENABLE ROW LEVEL SECURITY;",
      "CREATE POLICY trip_goals_select_crew ON public.trip_goals FOR SELECT USING (authz.is_trip_crew(trip_id));",
      "GRANT SELECT ON public.trip_goals TO authenticated;",
      "ALTER TABLE public.trip_risks ENABLE ROW LEVEL SECURITY;",
      "CREATE POLICY trip_risks_select_crew ON public.trip_risks FOR SELECT USING (authz.is_trip_crew(trip_id));",
      "GRANT SELECT ON public.trip_risks TO authenticated;",
    ]);
  });

  it("writes out a DO block's DECLAREd literal, and not one the body reassigns (2276's shape)", () => {
    const fixed = expandForeachLiteralLoops(`DO $$
DECLARE t text := 'intel_presence_verifications';
BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION public.intel_append_only()', t || '_no_truncate', t);
END $$;`);
    assert.match(fixed, /^CREATE TRIGGER intel_presence_verifications_no_truncate BEFORE TRUNCATE ON public\.intel_presence_verifications /);
    const reassigned = expandForeachLiteralLoops(`DO $$
DECLARE t text := 'a';
BEGIN
  t := 'b';
  EXECUTE format('GRANT SELECT ON public.%I TO anon', t);
END $$;`);
    assert.equal(reassigned, "");
  });

  it("refuses what it cannot evaluate exactly: positional placeholders, computed arguments, non-literal arrays", () => {
    for (const body of [
      "FOREACH t IN ARRAY ARRAY['a'] LOOP EXECUTE format('GRANT SELECT ON public.%1$I TO anon', t); END LOOP;",
      "FOREACH t IN ARRAY ARRAY['a'] LOOP EXECUTE format('GRANT SELECT ON public.%I TO anon', upper(t)); END LOOP;",
      "FOREACH t IN ARRAY ARRAY['a'] LOOP EXECUTE format('GRANT SELECT ON public.%I TO %s', t, v_role); END LOOP;",
      "FOREACH t IN ARRAY v_tables LOOP EXECUTE format('GRANT SELECT ON public.%I TO anon', t); END LOOP;",
      "FOREACH t IN ARRAY ARRAY[v_x, 'b'] LOOP EXECUTE format('GRANT SELECT ON public.%I TO anon', t); END LOOP;",
    ]) {
      assert.equal(expandForeachLiteralLoops(`DO $$ BEGIN ${body} END $$;`), "", body);
    }
  });

  it("expands the real 3002 loop into the three contributor-token triggers the audit reported", () => {
    const out = expandForeachLiteralLoops(mgMig("3002_intel_contribution_identity.sql"));
    for (const t of ["intel_observations", "intel_evidence", "intel_confirmations"]) {
      assert.match(out, new RegExp(`CREATE TRIGGER ${t}_contributor_token BEFORE INSERT ON public\\.${t} `));
    }
  });
});

describe("buildModel — history before the baseline, chain after it", () => {
  const baselineTables = new Map<string, { table: string; rlsEnabled: boolean; policyCount: number }>();
  const policy = (pred: string) => `CREATE POLICY p ON public.t FOR INSERT WITH CHECK (${pred});`;

  it("a pre-baseline file's stale CREATE POLICY does not overwrite the baseline's predicate", () => {
    const model = buildModel({
      baselineSql: policy("(auth.uid() = owner_id)"),
      baselineTables,
      historicalSqls: [policy("auth.uid() = user_id")],
      canonicalSqls: [],
      ledger: [],
      parseMig: noParse,
    });
    assert.equal(normalizePredicate(model.policies.get("public.t.p")!.withCheck), "auth.uid() = owner_id");
  });

  it("a post-baseline file still replaces the baseline's predicate (the chain is newer)", () => {
    const model = buildModel({
      baselineSql: policy("(auth.uid() = owner_id)"),
      baselineTables,
      historicalSqls: [],
      canonicalSqls: [policy("auth.uid() = creator_id")],
      ledger: [],
      parseMig: noParse,
    });
    assert.equal(normalizePredicate(model.policies.get("public.t.p")!.withCheck), "auth.uid() = creator_id");
  });

  it("partitions filenames at CHAIN_START_PREFIX, which is the replay harness's own boundary", () => {
    const { historical, canonical } = partitionByChainStart(["2093_a.sql", "0026_b.sql", "20260808_c.sql", "3740_d.sql", "2092_e.sql"]);
    assert.deepEqual(historical, ["0026_b.sql", "20260808_c.sql", "2092_e.sql"]);
    assert.deepEqual(canonical, ["2093_a.sql", "3740_d.sql"]);
    const upSh = mgRead(mgJoin(MG_API, "scripts", "local-db", "up.sh"), "utf8");
    const from = /FROM="\$\{LOCAL_DB_FROM:-(\d{4})\}"/.exec(upSh);
    assert.ok(from, "up.sh no longer declares its chain start");
    assert.equal(CHAIN_START_PREFIX, `${from![1]}_`);
  });

  it("on the REAL tree: highlights_insert reads the baseline's owner_id, not 0026's user_id", () => {
    const files = mgReaddir(MG_MIGRATIONS).filter((f) => f.endsWith(".sql"));
    const { historical, canonical } = partitionByChainStart(files);
    const baselineSql = mgRead(mgJoin(MG_API, "baseline", "20260819_baseline_structure.sql"), "utf8");
    const model = buildModel({
      baselineSql,
      baselineTables,
      historicalSqls: historical.map(mgMig),
      canonicalSqls: canonical.map(mgMig),
      ledger: [],
      parseMig: noParse,
    });
    assert.equal(normalizePredicate(model.policies.get("public.highlights.highlights_insert")!.withCheck), "auth.uid() = owner_id");
    // And the loop- and multi-target-issued objects the audit reported are modelled.
    for (const t of ["trip_goals", "trip_decision_tasks", "trip_risks", "trip_presence", "trip_proposals", "trip_snapshots",
      "trip_outcomes", "trip_subgroups", "trip_subgroup_members", "trip_meeting_checkpoints", "trip_meeting_checkpoint_participants"]) {
      assert.ok(model.tableGrants.get(`${t}.authenticated`)?.has("select"), `${t}: authenticated SELECT not modelled`);
    }
    for (const p of ["trip_decision_tasks.trip_decision_tasks_select_crew", "trip_risks.trip_risks_select_crew",
      "trip_presence.trip_presence_select_crew", "trip_outcomes.trip_outcomes_select_crew"]) {
      assert.ok(model.policies.has(`public.${p}`), `${p} not modelled`);
    }
  });
});
