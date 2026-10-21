/**
 * certify:migrations stage 4 — declared postcondition AMENDMENTS
 * (lib/postconditionAmendments.ts, planned by planPostconditionAmendments /
 * amendBlock in lib/migrationSqlBlocks.ts).
 *
 * Why they exist: a beta bootstrap certifies the whole chain in one run, and
 * the offline rehearsal of the reset bootstrap on #711 head (d981724bb) failed
 * stage 4 on 33 blocks, each a statement a LATER migration deliberately made
 * false (or a read of apply-transaction state). Every applied migration is
 * checksum-locked, so 3801's header marker cannot be used; these declarations
 * drop one statement at a time and keep the rest of each block.
 *
 *   A. the planner and amendBlock, on synthetic SQL: what is dropped, what is
 *      refused, when a declaration does not apply (fail closed), re-assertion;
 *   B. EVERY declaration on disk: block identity, spans, apply order, the
 *      superseder touches the object, every object the dropped statement reads
 *      is named by a re-assertion, failsWith names what the span asserts, the
 *      justification names the superseder;
 *   C. session-bound declarations ⟺ check:migration-session-state's findings
 *      for stage-4 blocks (no session-bound block is left un-amended, none is
 *      amended without the finding);
 *   D. certify:migrations is wired to the plan.
 * The chain-end half — as written FAILS, amended PASSES, each drop necessary
 * with its declared error, re-assertions PASS — is
 * db/postconditionAmendments.db.test.ts (CI local-db, real PostgreSQL).
 *
 * Run: node --import tsx/esm --test src/test/certifyPostconditionAmendments.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  amendBlock,
  blockSha256,
  isAssertionOnlyDoBlock,
  maskForKeywordScan,
  planPostconditionAmendments,
  postconditionBlocks,
  type PostconditionAmendment,
} from "../scripts/lib/migrationSqlBlocks.js";
import { POSTCONDITION_AMENDMENTS } from "../scripts/lib/postconditionAmendments.js";
import { findSessionStateFindings } from "../scripts/lib/migrationSessionState.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIG = resolve(HERE, "..", "migrations");
const APPLIER = resolve(HERE, "../../../../scripts/src/apply-migrations.ts");
const sqlOf = (f: string) => readFileSync(join(MIG, f), "utf8");
const onDisk = (f: string) => existsSync(join(MIG, f));

// ── object tokens: what a statement reads ────────────────────────────────────

const stripComments = (s: string) => s.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
/** A LIKE pattern as the literal prefix it names ('memory\_%' -> memory_). */
const likePrefix = (p: string) => p.replace(/\\/g, "").split("%")[0]!;

/** The relations, functions, policies, triggers, constraints and indexes a SQL text names. */
export function objectTokens(text: string): Set<string> {
  const s = stripComments(text);
  const out = new Set<string>();
  const pats = [
    /'(?:public|authz)\.([a-z0-9_]+)'::regclass/gi,
    /to_regclass\(\s*'(?:public\.)?([a-z0-9_]+)'/gi,
    /\b(?:table_name|tablename|relname|viewname|polname|policyname|proname|tgname|conname|indexname)\s*=\s*'([a-z0-9_]+)'/gi,
    /has_(?:table|column|function)_privilege\([^,()]+,\s*'(?:public\.)?([a-z0-9_]+)/gi,
    /to_regproc(?:edure)?\(\s*'(?:public\.|authz\.)?([a-z0-9_]+)/gi,
    /'(?:public\.)?([a-z0-9_]+)\([^']*\)'::regprocedure/gi,
    /\b(?:from|join)\s+public\.([a-z0-9_]+)/gi,
    /\bpublic\.([a-z0-9_]+)\s*\(/gi,
  ];
  for (const re of pats) for (const m of s.matchAll(re)) out.add(m[1]!.toLowerCase());
  for (const m of s.matchAll(/\bproname\s+like\s+'([^']+)'/gi)) out.add(likePrefix(m[1]!).toLowerCase());
  return out;
}

/**
 * The objects a dropped span depends on: those it names, plus those named by
 * the block's statements that assign a variable the span reads (`d :=
 * pg_get_functiondef(...)`, `SELECT ... INTO ins FROM ... WHERE table_name = ...`).
 */
export function dependencyTokens(blockText: string, span: string): Set<string> {
  const tokens = objectTokens(span);
  const vars = new Set([...stripComments(span).matchAll(/\b([a-z_][a-z0-9_]*)\b/gi)].map((m) => m[1]!.toLowerCase()));
  for (const st of stripComments(blockText).split(";")) {
    const assigned = [...st.matchAll(/\b([a-z_][a-z0-9_]*)\s*:=/gi)].map((m) => m[1]!.toLowerCase());
    const into = /\binto\s+([a-z_][a-z0-9_]*(?:\s*,\s*[a-z_][a-z0-9_]*)*)/i.exec(st)?.[1]?.split(",").map((x) => x.trim().toLowerCase()) ?? [];
    if ([...assigned, ...into].some((v) => vars.has(v))) for (const t of objectTokens(st)) tokens.add(t);
  }
  return tokens;
}

/** Does `text` name `token` (left word boundary; a LIKE prefix or a successor's longer name counts). */
const names = (text: string, token: string) =>
  new RegExp(`(?<![A-Za-z0-9_])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(stripComments(text).replace(/\\/g, ""));

const spanOf = (sql: string, [a, z]: readonly [number, number]) => sql.split("\n").slice(a - 1, z).join("\n");
const blockAt = (file: string, line: number) => postconditionBlocks(sqlOf(file)).find((b) => b.firstLine === line);

/**
 * A drop must be WHOLE statements (verifier V-714 F5: a one-line shift that kept
 * failsWith's words passed every static check). Its last code line ends a
 * statement, the code line before it ends one (or opens a body: THEN / LOOP /
 * BEGIN / ELSE / DECLARE / the DO line), and IF…END IF, LOOP…END LOOP and
 * parentheses balance inside it — literals and comments masked first.
 */
export function spanShapeProblems(sql: string, [a, z]: readonly [number, number]): string[] {
  const lines = sql.split("\n");
  const code = (l: string) => maskForKeywordScan(l).replace(/--.*$/, "").trim();
  const problems: string[] = [];
  const spanCode = lines.slice(a - 1, z).map(code).filter((l) => l !== "");
  if (spanCode.length === 0) return ["the span holds no code"];
  if (!spanCode[spanCode.length - 1]!.endsWith(";")) problems.push(`line ${z} does not end a statement`);
  let before = "";
  for (let i = a - 2; i >= 0 && before === ""; i--) before = code(lines[i]!);
  if (!/;$/.test(before) && !/\b(?:THEN|LOOP|BEGIN|ELSE|DECLARE)$/i.test(before) && !/^DO\b/i.test(before)) {
    problems.push(`the code before line ${a} does not end a statement ("${before.slice(-40)}")`);
  }
  const masked = maskForKeywordScan(lines.slice(a - 1, z).join("\n")).replace(/--[^\n]*/g, " ");
  const n = (re: RegExp) => (masked.match(re) ?? []).length;
  const endIf = n(/\bEND\s+IF\b/gi);
  const endLoop = n(/\bEND\s+LOOP\b/gi);
  if (n(/\bIF\b/gi) - endIf !== endIf) problems.push("IF / END IF do not balance");
  if (n(/\bLOOP\b/gi) - endLoop !== endLoop) problems.push("LOOP / END LOOP do not balance");
  if (n(/\(/g) !== n(/\)/g)) problems.push("parentheses do not balance");
  return problems;
}

/**
 * The counted literals of a COUNT-PIN statement (`n := (length(d) - length(replace(d, <literal>, '')))…`):
 * the identifiers inside its string literals, RAISE messages and the `v_family` scaffold excluded.
 * Empty for a statement that pins no count.
 */
export function countedTokens(span: string): Set<string> {
  if (!/\blength\s*\(\s*\w+\s*\)\s*-\s*length\s*\(\s*replace\s*\(/i.test(span)) return new Set();
  const noRaise = span.replace(/RAISE\s+EXCEPTION\s+'(?:[^']|'')*'/gi, " ");
  const out = new Set<string>();
  for (const lit of noRaise.match(/'(?:[^']|'')*'/g) ?? []) {
    for (const w of lit.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) if (w !== "v_family") out.add(w);
  }
  return out;
}

// ── A. the planner, on synthetic SQL ─────────────────────────────────────────

const F = [
  "BEGIN;",
  "CREATE TABLE t (a int);",
  "COMMIT;",
  "DO $post$",
  "DECLARE n int;",
  "BEGIN",
  "  IF to_regclass('public.t') IS NULL THEN RAISE EXCEPTION 'POSTCONDITION FAILED: t missing'; END IF;",
  "  SELECT count(*) INTO n FROM information_schema.columns WHERE table_name = 't';",
  "  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: expected 1 column, found %', n; END IF;",
  "  IF n > 5 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: too many'; END IF;",
  "END",
  "$post$;",
  "",
].join("\n");
const G = "DO $post$ BEGIN IF to_regclass('public.t') IS NULL THEN RAISE EXCEPTION 'G: t missing'; END IF; END $post$;\n";
const H = "DO $post$ BEGIN IF to_regclass('public.t') IS NULL THEN RAISE EXCEPTION 'H: t missing'; END IF; END $post$;\n";
const files: Record<string, string> = { "1000_f.sql": F, "2000_g.sql": G, "3000_h.sql": H, "4000_none.sql": "SELECT 1;\n" };
const sqlOfFixture = (f: string) => files[f] ?? null;
const blockF = postconditionBlocks(F)[0]!;
const decl = (over: Partial<PostconditionAmendment> = {}): PostconditionAmendment => ({
  file: "1000_f.sql",
  blockLine: 4,
  blockSha256: blockSha256(blockF.text),
  kind: "superseded",
  drops: [{ lines: [9, 9], failsWith: "expected 1 column", supersededBy: "2000_g.sql" }],
  why: "2000 adds a column on purpose",
  ...over,
});

describe("A. postconditionBlocks / amendBlock / planPostconditionAmendments", () => {
  it("postconditionBlocks finds the block where `DO` is, and ends at its `;`", () => {
    assert.equal(blockF.firstLine, 4);
    assert.equal(blockF.lastLine, 12);
    assert.equal(blockF.index, 1);
  });

  it("amendBlock removes exactly the span, and the rest is re-run", () => {
    const r = amendBlock(F, blockF, [{ lines: [9, 9] }]);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(!r.text.includes("expected 1 column"));
    assert.ok(r.text.includes("t missing") && r.text.includes("too many"));
    assert.ok(isAssertionOnlyDoBlock(r.text));
  });

  it("amendBlock refuses a span outside the block, overlapping or blank spans, and a span that is not unique", () => {
    assert.equal(amendBlock(F, blockF, [{ lines: [2, 2] }]).ok, false);
    assert.equal(amendBlock(F, blockF, [{ lines: [9, 10] }, { lines: [10, 10] }]).ok, false);
    assert.equal(amendBlock(F, blockF, [{ lines: [13, 13] }]).ok, false);
    const dup = F.replace("  IF n > 5 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: too many'; END IF;", "  IF n <> 1 THEN RAISE EXCEPTION 'POSTCONDITION FAILED: expected 1 column, found %', n; END IF;");
    const b = postconditionBlocks(dup)[0]!;
    assert.match((amendBlock(dup, b, [{ lines: [9, 9] }]) as { reason: string }).reason, /exactly one span/);
  });

  it("narrow, never delete: removing every RAISE is refused", () => {
    const r = amendBlock(F, blockF, [{ lines: [7, 7] }, { lines: [9, 10] }]);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /never delete/);
  });

  it("applies only while the superseder is recorded applied (fail closed otherwise)", () => {
    const on = planPostconditionAmendments({ files: ["1000_f.sql"], applied: new Set(["1000_f.sql", "2000_g.sql"]), amendments: [decl()], sqlOf: sqlOfFixture });
    assert.deepEqual(on.refused, []);
    const f = on.blocks.find((b) => b.file === "1000_f.sql")!;
    assert.ok(!f.text.includes("expected 1 column"));
    assert.deepEqual(f.dropped, [{ lines: [9, 9], because: "superseded by 2000_g.sql" }]);
    const off = planPostconditionAmendments({ files: ["1000_f.sql"], applied: new Set(["1000_f.sql"]), amendments: [decl()], sqlOf: sqlOfFixture });
    assert.equal(off.blocks.find((b) => b.file === "1000_f.sql")!.text, blockF.text, "superseder not applied: as written");
    assert.deepEqual(off.reasserted, []);
  });

  it("the superseder's postconditions are re-run in its place even when out of scope", () => {
    const p = planPostconditionAmendments({ files: ["1000_f.sql"], applied: new Set(["1000_f.sql", "2000_g.sql"]), amendments: [decl()], sqlOf: sqlOfFixture });
    assert.deepEqual(p.reasserted, [{ file: "2000_g.sql", for: "1000_f.sql:4" }]);
    assert.ok(p.blocks.some((b) => b.file === "2000_g.sql" && b.text.trim() === G.trim()));
  });

  it("re-assertion is resolved (header supersession) and amended in turn", () => {
    const gDecl: PostconditionAmendment = {
      file: "2000_g.sql", blockLine: 1, blockSha256: blockSha256(postconditionBlocks(G)[0]!.text), kind: "superseded",
      drops: [{ lines: [1, 1], failsWith: "x", supersededBy: "3000_h.sql" }], why: "3000",
    };
    // 2000's only line is its whole block, so dropping it is refused (never delete) and it runs as written.
    const p = planPostconditionAmendments({
      files: ["1000_f.sql"], applied: new Set(["1000_f.sql", "2000_g.sql", "3000_h.sql"]), amendments: [decl(), gDecl], sqlOf: sqlOfFixture,
    });
    assert.ok(p.refused.some((r) => r.startsWith("2000_g.sql:1:") && /never delete/.test(r)), p.refused.join("\n"));
    assert.ok(p.blocks.some((b) => b.file === "3000_h.sql"), "3000 re-asserts 2000 in turn");
    const r = planPostconditionAmendments({
      files: ["1000_f.sql"], applied: new Set(["1000_f.sql", "2000_g.sql"]), amendments: [decl()], sqlOf: sqlOfFixture,
      resolveSuperseded: (f) => (f === "2000_g.sql" ? "3000_h.sql" : f),
    });
    assert.deepEqual(r.reasserted, [{ file: "3000_h.sql", for: "1000_f.sql:4" }]);
  });

  it("refusals: drifted text, two declarations, no superseder, a re-assertion with no postcondition, nothing re-asserting, a non-assertion inline re-assertion", () => {
    const run = (amendments: PostconditionAmendment[]) =>
      planPostconditionAmendments({ files: ["1000_f.sql"], applied: new Set(["1000_f.sql", "2000_g.sql", "4000_none.sql"]), amendments, sqlOf: sqlOfFixture });
    const asWritten = (p: ReturnType<typeof run>) => p.blocks.find((b) => b.file === "1000_f.sql")!.text === blockF.text;
    for (const [label, a] of [
      ["sha", [decl({ blockSha256: "0000000000000000" })]],
      ["two", [decl(), decl()]],
      ["no superseder", [decl({ drops: [{ lines: [9, 9], failsWith: "x" }] })]],
      ["re-assertion without postcondition", [decl({ reassertedBy: ["4000_none.sql"] })]],
      ["nothing re-asserts", [decl({ reassertedBy: [] })]],
      ["inline not an assertion", [decl({ reassertedBy: [], reassert: "DO $$ BEGIN DELETE FROM t; RAISE NOTICE 'x'; END $$;" })]],
    ] as Array<[string, PostconditionAmendment[]]>) {
      const p = run(a);
      assert.equal(p.refused.length > 0, true, `${label}: refused`);
      assert.ok(asWritten(p), `${label}: the block is re-run as written`);
    }
  });

  it("session-bound drops apply without a ledger; an inline re-assertion is added once", () => {
    const s = planPostconditionAmendments({
      files: ["1000_f.sql"], applied: new Set(), sqlOf: sqlOfFixture,
      amendments: [decl({ kind: "session-bound", sessionState: "n", drops: [{ lines: [9, 9], failsWith: "x" }] })],
    });
    assert.deepEqual(s.refused, []);
    assert.deepEqual(s.blocks[0]!.dropped[0]!.because, "session-bound: reads n only its own apply transaction had");
    const inline = "DO $r$ BEGIN IF to_regclass('public.t') IS NULL THEN RAISE EXCEPTION 'r'; END IF; END $r$;";
    const i = planPostconditionAmendments({
      files: ["1000_f.sql"], applied: new Set(["2000_g.sql"]), sqlOf: sqlOfFixture,
      amendments: [decl({ reassertedBy: [], reassert: inline })],
    });
    assert.equal(i.blocks.filter((b) => b.text === inline).length, 1);
  });
});

// ── B. every declaration on disk ─────────────────────────────────────────────

interface Applier {
  orderMigrations: (files: readonly string[], overrides: readonly unknown[]) => string[];
  listMigrationFiles: (dir?: string) => string[];
  readOrderOverrides: (dir?: string) => Array<{ skip?: string }>;
  classifyMigration: (sql: string, filename: string) => { kind: string; postconditions?: string };
}
const applier = (await import(pathToFileURL(APPLIER).href)) as Applier;
const ORDER = applier.orderMigrations(applier.listMigrationFiles(MIG), applier.readOrderOverrides(MIG));
const pos = (f: string) => ORDER.indexOf(f);
const reasserting = (a: PostconditionAmendment) => a.reassertedBy ?? [...new Set(a.drops.map((d) => d.supersededBy!))];

describe("B. every declaration in lib/postconditionAmendments.ts", () => {
  it("anti-vacuity: the 34 blocks and 53 statements (33/52 measured on the 2026-10-14 rehearsal, + 2786:96 superseded by 3826)", () => {
    assert.equal(POSTCONDITION_AMENDMENTS.length, 34);
    assert.equal(POSTCONDITION_AMENDMENTS.reduce((n, a) => n + a.drops.length, 0), 53);
  });

  it("anti-vacuity for the count-pin rule (V-714 F4): it binds the 16 superseded kernel count statements (3826 superseded 2786's engine count)", () => {
    let n = 0;
    for (const a of POSTCONDITION_AMENDMENTS) {
      if (a.kind !== "superseded") continue;
      for (const d of a.drops) if (countedTokens(spanOf(sqlOf(a.file), d.lines)).size > 0) n++;
    }
    assert.equal(n, 16);
  });

  it("V-714 F3: 2151:113/117 and 2158:38/40 pinned EXACTLY SELECT at table level, so their declarations re-assert NO client table-level privilege on both tables", () => {
    for (const [file, line] of [["2151_passport_postcards_write_boundary.sql", 107], ["2158_post_media_write_boundary.sql", 34]] as const) {
      const a = POSTCONDITION_AMENDMENTS.find((x) => x.file === file && x.blockLine === line)!;
      assert.ok(a.reassert, `${file}: no inline re-assertion`);
      assert.match(a.reassert!, /aclexplode\(c\.relacl\)/, "every privilege type, from relacl");
      for (const t of ["'public.passport_postcards'::regclass", "'public.post_media'::regclass"]) assert.ok(a.reassert!.includes(t), `${file}: ${t}`);
      assert.match(a.reassert!, /a\.grantee = 0 OR a\.grantee IN \(SELECT r\.oid FROM pg_roles r WHERE r\.rolname IN \('anon', 'authenticated'\)\)/, "PUBLIC, anon and authenticated");
    }
  });

  it("one declaration per block", () => {
    const keys = POSTCONDITION_AMENDMENTS.map((a) => `${a.file}:${a.blockLine}`);
    assert.equal(new Set(keys).size, keys.length);
  });

  for (const a of POSTCONDITION_AMENDMENTS) {
    describe(`${a.file}:${a.blockLine} (${a.kind})`, () => {
      it("names a chain file, a re-runnable postcondition block there, with the pinned text", () => {
        assert.ok(onDisk(a.file), "not on disk");
        assert.ok(pos(a.file) >= 0, "not in the applier's chain order");
        const b = blockAt(a.file, a.blockLine);
        assert.ok(b, `no re-runnable postcondition starts at line ${a.blockLine}`);
        assert.equal(blockSha256(b!.text), a.blockSha256);
      });

      it("every drop is a whole-line span of the block, and dropping them all leaves an assertion-only block", () => {
        const sql = sqlOf(a.file);
        const r = amendBlock(sql, blockAt(a.file, a.blockLine)!, a.drops);
        assert.ok(r.ok, (r as { reason?: string }).reason);
        assert.ok(a.drops.length > 0);
        for (const d of a.drops) assert.ok(d.failsWith.trim().length >= 8, "failsWith too short to mean anything");
      });

      it("every drop is whole statements: no shifted or half span (verifier V-714 F5)", () => {
        const sql = sqlOf(a.file);
        for (const d of a.drops) assert.deepEqual(spanShapeProblems(sql, d.lines), [], `${a.file}:${d.lines.join("-")}`);
      });

      it("failsWith names what the dropped span asserts", () => {
        const sql = sqlOf(a.file);
        for (const d of a.drops) {
          const span = spanOf(sql, d.lines);
          const words = d.failsWith.match(/[A-Za-z_][A-Za-z0-9_]{5,}/g) ?? [];
          assert.ok(words.some((w) => span.includes(w)), `${d.lines.join("-")}: none of ${words.join(", ")} is in the span`);
        }
      });

      it("the justification names every superseding and re-asserting migration", () => {
        assert.ok(a.why.trim().length > 40);
        const named = [...a.drops.map((d) => d.supersededBy), ...(a.reassertedBy ?? [])].filter((x): x is string => !!x);
        for (const f of named) assert.ok(a.why.includes(f.slice(0, 4)), `why does not name ${f.slice(0, 4)}`);
      });

      if (a.kind === "superseded") {
        it("each superseder exists, is applied LATER in the applier's order, and touches what the statement reads", () => {
          const sql = sqlOf(a.file);
          const block = blockAt(a.file, a.blockLine)!;
          for (const d of a.drops) {
            assert.ok(d.supersededBy, "no supersededBy");
            assert.ok(onDisk(d.supersededBy!), `${d.supersededBy} not on disk`);
            assert.ok(pos(d.supersededBy!) > pos(a.file), `${d.supersededBy} is not applied after ${a.file}`);
            const deps = dependencyTokens(block.text, spanOf(sql, d.lines));
            assert.ok(deps.size > 0, `${d.lines.join("-")}: the statement reads no object this test can name`);
            assert.ok([...deps].some((t) => names(sqlOf(d.supersededBy!), t)), `${d.supersededBy} names none of ${[...deps].join(", ")}`);
          }
        });

        it("a dropped COUNT pin is re-pinned by the inline re-assertion, literal for literal (verifier V-714 F4)", () => {
          const sql = sqlOf(a.file);
          for (const d of a.drops) {
            const counted = countedTokens(spanOf(sql, d.lines));
            if (counted.size === 0) continue;
            assert.ok(a.reassert, `${d.lines.join("-")} pins a count (${[...counted].join(", ")}); naming the object is not re-pinning it — an inline re-assertion must`);
            for (const t of counted) {
              assert.ok(new RegExp(`(?<![A-Za-z0-9_])${t}(?![A-Za-z0-9_])`).test(a.reassert!), `${d.lines.join("-")} counts ${t}; the re-assertion does not pin it`);
            }
          }
        });

        it("something re-asserts it, and names every object each dropped statement reads", () => {
          const files = reasserting(a);
          assert.ok(files.length > 0 || a.reassert !== undefined, "nothing re-asserts the dropped statements");
          for (const f of files) {
            assert.ok(onDisk(f), `${f} not on disk`);
            assert.ok(pos(f) > pos(a.file), `${f} is not applied after ${a.file}`);
            assert.ok(postconditionBlocks(sqlOf(f)).length > 0, `${f} has no re-runnable postcondition`);
          }
          if (a.reassert !== undefined) assert.ok(isAssertionOnlyDoBlock(a.reassert), "the inline re-assertion is not an assertion-only DO block");
          const text = [...files.flatMap((f) => postconditionBlocks(sqlOf(f)).map((b) => b.text)), a.reassert ?? ""].join("\n");
          const sql = sqlOf(a.file);
          const block = blockAt(a.file, a.blockLine)!;
          for (const d of a.drops) {
            for (const t of dependencyTokens(block.text, spanOf(sql, d.lines))) {
              assert.ok(names(text, t), `${d.lines.join("-")} reads ${t}; no re-assertion names it`);
            }
          }
        });
      } else {
        it("session-bound: no superseder, and every drop reads the declared state", () => {
          assert.ok(a.sessionState, "sessionState missing");
          assert.equal(a.reassertedBy, undefined);
          assert.equal(a.reassert, undefined);
          for (const d of a.drops) {
            assert.equal(d.supersededBy, undefined);
            assert.ok(spanOf(sqlOf(a.file), d.lines).includes(a.sessionState!), `${d.lines.join("-")} does not read ${a.sessionState}`);
          }
        });
      }
    });
  }
});

// ── C. session-bound declarations ⟺ check:migration-session-state ───────────

describe("C. session-bound declarations match check:migration-session-state, both ways", () => {
  const skips = new Set(applier.readOrderOverrides(MIG).map((o) => o.skip).filter((x): x is string => !!x));
  const stage4Findings: Array<{ file: string; line: number; name: string }> = [];
  for (const f of readdirSync(MIG).filter((x) => x.endsWith(".sql")).sort()) {
    if (skips.has(f)) continue;
    for (const x of findSessionStateFindings(f, sqlOf(f), applier.classifyMigration).findings) {
      if ((x.rule === "temp-table" || x.rule === "session-guc") && x.runBy.includes("certify stage 4")) {
        stage4Findings.push({ file: x.file, line: x.line, name: x.name });
      }
    }
  }
  const sessionBound = POSTCONDITION_AMENDMENTS.filter((a) => a.kind === "session-bound");

  it("anti-vacuity: the three KNOWN findings (2570, 2745, 2798)", () => {
    assert.deepEqual([...new Set(stage4Findings.map((x) => x.file))].sort(), [
      "2570_intel_live_scope_admin_surface_flag.sql",
      "2745_layover_recommendation_travel_provenance.sql",
      "2798_trip_kernel_recurrence_family.sql",
    ]);
  });

  it("every stage-4 session-state finding has a session-bound declaration for that block and that state", () => {
    for (const x of stage4Findings) {
      const b = postconditionBlocks(sqlOf(x.file)).find((p) => p.firstLine <= x.line && x.line <= p.lastLine);
      assert.ok(b, `${x.file}:${x.line} is not inside a stage-4 block`);
      assert.ok(sessionBound.some((a) => a.file === x.file && a.blockLine === b!.firstLine && a.sessionState === x.name), `${x.file}:${b!.firstLine} reads ${x.name} and is not declared`);
    }
  });

  it("every session-bound declaration is backed by such a finding", () => {
    for (const a of sessionBound) {
      const b = blockAt(a.file, a.blockLine)!;
      assert.ok(
        stage4Findings.some((x) => x.file === a.file && x.name === a.sessionState && b.firstLine <= x.line && x.line <= b.lastLine),
        `${a.file}:${a.blockLine} declares ${a.sessionState} with no session-state finding`,
      );
    }
  });
});

// ── D. certify:migrations is wired to the plan ──────────────────────────────

describe("D. certify:migrations stage 4 sends the planned (amended) blocks", () => {
  const src = readFileSync(resolve(HERE, "..", "scripts", "certifyMigrations.ts"), "utf8");
  it("plans with POSTCONDITION_AMENDMENTS, the ledger as `applied`, and header supersession as the resolver", () => {
    assert.match(src, /import \{ POSTCONDITION_AMENDMENTS \} from "\.\/lib\/postconditionAmendments\.js";/);
    assert.match(src, /planPostconditionAmendments\(\{\s*files: plan\.run,\s*applied,\s*amendments: POSTCONDITION_AMENDMENTS,/);
    assert.match(src, /resolveSuperseded: \(f\) => planPostconditionRerun\(\[f\], applied, declarations, hasPostcondition\)\.run\[0\]/);
  });
  it("re-runs each planned block's text, and nothing else, in stage 4", () => {
    assert.match(src, /for \(const b of amended\.blocks\) \{[\s\S]*?await query\(b\.text\);/);
    assert.doesNotMatch(src, /for \(const block of d\.postconditions\)/, "the unamended per-file loop is gone");
    assert.match(src, /for \(const r of amended\.refused\) problems\.push\(/, "a refused declaration fails the stage");
  });
  it("a scope no declaration names keeps the old plan exactly (no ledger read)", () => {
    assert.match(src, /if \(!headerNamesScope && !amendmentNamesScope\) \{/);
  });
});

// ── E. the db half runs FIRST, alone, on the freshly replayed chain ─────────

describe("E. scripts/local-db/run-tests.sh runs the amendments db suite first and alone (verifier V-714 F2)", () => {
  const sh = readFileSync(resolve(HERE, "..", "..", "scripts", "local-db", "run-tests.sh"), "utf8").split("\n").filter((l) => !/^\s*#/.test(l));
  const at = (re: RegExp) => sh.findIndex((l) => re.test(l));
  it("names it, refuses when it is missing, and keeps it out of the sorted pack", () => {
    assert.ok(at(/^FIRST="src\/test\/db\/postconditionAmendments\.db\.test\.ts"$/) >= 0);
    assert.ok(existsSync(resolve(HERE, "db", "postconditionAmendments.db.test.ts")));
    assert.ok(at(/\[ -f "\$FIRST" \] \|\| \{.*exit 2; \}/) >= 0, "a missing first suite must fail");
    assert.ok(at(/^FILES=\$\(ls src\/test\/db\/\*\.db\.test\.ts \| grep -vxF "\$FIRST"/) >= 0, "the first suite must not run again in the pack");
  });
  it("runs it in its own node --test BEFORE the pack, and its exit code and tallies count", () => {
    const first = at(/node --import tsx\/esm --test .*"\$FIRST"/);
    const pack = at(/node --import tsx\/esm --test .*\$FILES/);
    assert.ok(first >= 0 && pack >= 0 && first < pack, `first run at ${first}, pack at ${pack}`);
    assert.ok(at(/^\[ "\$rc_first" = "0" \] \|\| exit "\$rc_first"$/) > pack);
    assert.ok(at(/grep -hE "\^# \$1 " "\$OUT_FIRST" "\$OUT"/) > pack, "both tallies are summed");
  });
});

