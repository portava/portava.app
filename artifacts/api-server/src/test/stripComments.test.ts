/**
 * The adversarial test for src/scripts/lib/stripComments.ts.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * stripComments answers the question "what is the CODE here, as opposed to the
 * prose about it", and 24 files in this tree build a verdict on its answer:
 * checkStateMachineWriters, checkProjectionConsumers, checkGuardReachability,
 * checkAsyncHandlers, checkMissingLiveColumns, lib/deletion/userLink.ts, and a
 * dozen source-scanning suites. It was written BECAUSE four separate guards had
 * each shipped the same bug — matching raw file text and counting a comment as
 * code — and it had no test of its own. It then shipped a bug of the same
 * family in the OTHER direction: it scanned for `/*` before `//`, so an
 * ordinary line comment containing a glob or URL opened a block comment that
 * ran to the next close-marker anywhere in the file.
 *
 * Measured over src/ before the fix: 12 files affected, 2,510 non-blank lines
 * of real code handed to every caller as blank lines. The largest single
 * casualty was ~969 lines of routes/rentABuddySpec.ts, which contains a state
 * machine writer; 67 lines of routes/index.ts and 38 of app.ts — the route
 * registration surface — went with it.
 *
 * That failure is invisible by construction. A guard cannot find a defect in
 * text it was given as blanks, and it reports the resulting silence as a pass.
 * So the properties below are pinned, and the corpus check at the end compares
 * the shipped implementation against an INDEPENDENT reference scanner written
 * to the same contract by a different algorithm, over the whole real tree.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../scripts/lib/stripComments.js";
import { stripSqlComments } from "../scripts/lib/canonicalSchema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

// ─────────────────────────────────────────────────────────────────────────────
// THE REGRESSION. A line comment containing `/*` opens nothing.
// ─────────────────────────────────────────────────────────────────────────────
describe("a `/*` inside a line comment opens nothing", () => {
  it("code after such a comment survives", () => {
    const src = [
      "const before = 1;",
      "// the client's /api/buddy-bookings/* URLs reach them through the rewrite",
      "const after = 2;",
      "function resolveDispute() { return sc.from('x').update({ status: 'cancelled' }); }",
    ].join("\n");
    const out = stripComments(src);
    assert.match(out, /const before = 1;/);
    assert.match(out, /const after = 2;/, "the line after the comment was erased");
    assert.match(out, /resolveDispute/, "a writer below the comment was erased");
    assert.doesNotMatch(out, /buddy-bookings/, "the comment text itself must be gone");
  });

  it("it does not swallow up to a LATER close marker", () => {
    const src = [
      "// glob: /assets/*",
      "const a = 1;",
      "/** an ordinary doc comment, whose */ closer is what the bug latched onto",
      "const b = 2;",
    ].join("\n");
    const out = stripComments(src);
    assert.match(out, /const a = 1;/);
    assert.match(out, /const b = 2;/);
  });

  it("the three real files that triggered this keep their code", () => {
    // Pinned by path and by a string each file must still contain after
    // stripping. If any of these ever reads as blank again, the stripper has
    // regressed and every guard built on it has gone quiet rather than red.
    const cases: Array<[string, RegExp]> = [
      ["routes/rentABuddySpec.ts", /NO_SHOW_REPORTABLE_STATUSES/],
      ["routes/index.ts", /router\./],
      ["app.ts", /express/],
    ];
    for (const [rel, must] of cases) {
      const out = stripComments(readFileSync(join(SRC, rel), "utf8"));
      assert.match(out, must, `${rel} lost code to comment stripping`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The ordinary contract.
// ─────────────────────────────────────────────────────────────────────────────
describe("comment removal", () => {
  it("removes a line comment and keeps the code before it", () => {
    assert.equal(stripComments("const a = 1; // note"), "const a = 1; ");
  });

  it("removes a single-line block comment from the middle of a line", () => {
    assert.equal(stripComments("const a = /* why */ 1;"), "const a =  1;");
  });

  it("removes a multi-line block comment and preserves the line count", () => {
    const src = ["const a = 1;", "/* one", " * two", " */", "const b = 2;"].join("\n");
    const out = stripComments(src);
    assert.equal(out.split("\n").length, 5, "line numbers must still line up");
    assert.match(out, /const a = 1;/);
    assert.match(out, /const b = 2;/);
    assert.doesNotMatch(out, /two/);
  });

  it("keeps code that follows a block comment's close on the same line", () => {
    assert.match(stripComments("/* x */ const a = 1;"), /const a = 1;/);
  });

  it("still strips a line comment that FOLLOWS a closed block comment", () => {
    const out = stripComments("const a = /* x */ 1; // tail");
    assert.match(out, /const a = {2}1;/);
    assert.doesNotMatch(out, /tail/);
  });

  it("an unterminated block comment runs to end of file", () => {
    const out = stripComments(["const a = 1; /* open", "const b = 2;", "const c = 3;"].join("\n"));
    assert.match(out, /const a = 1;/);
    assert.doesNotMatch(out, /const b/);
    assert.doesNotMatch(out, /const c/);
  });

  it("preserves the line count for every input above", () => {
    for (const src of ["a\nb\nc", "// x\n/* y\n */\nz", "a /* b */ c\n// d\ne"]) {
      assert.equal(stripComments(src).split("\n").length, src.split("\n").length);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The DELIBERATE limitation, pinned so that changing it is a decision.
// ─────────────────────────────────────────────────────────────────────────────
describe("string literals are deliberately NOT parsed", () => {
  it('a `//` inside a string truncates the line — a false NO, never a false YES', () => {
    const out = stripComments('const url = "https://example.com/x"; const after = 1;');
    assert.doesNotMatch(out, /after/, "the documented conservative direction changed");
    assert.match(out, /const url = "https:/);
  });

  it("that direction is the point: it can only ever REMOVE text", () => {
    // Whatever the input, every non-whitespace character of the output must
    // appear in the input. The stripper must never invent code.
    const inputs = [
      'a // b',
      '/* a */ b',
      'const s = "// not a comment"; run();',
      "// /* \nkeep();",
    ];
    for (const src of inputs) {
      const out = stripComments(src).replace(/\s/g, "");
      let i = 0;
      for (const ch of out) {
        i = src.indexOf(ch, i);
        assert.notEqual(i, -1, `stripComments invented ${JSON.stringify(ch)} from ${JSON.stringify(src)}`);
        i += 1;
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CORPUS — the shipped implementation against an independent reference, over
// the whole real tree. Different algorithm (character state machine vs. line
// scanner), same contract. Agreement on 1,600+ real files is the property the
// unit cases above cannot give on their own.
// ─────────────────────────────────────────────────────────────────────────────
function referenceStrip(text: string): string {
  let out = "";
  let state: "code" | "line" | "block" = "code";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const c2 = text[i + 1];
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "line"; i++; continue; }
      if (c === "/" && c2 === "*") { state = "block"; i++; continue; }
      out += c;
      continue;
    }
    if (state === "line") {
      if (c === "\n") { state = "code"; out += "\n"; }
      continue;
    }
    // block
    if (c === "*" && c2 === "/") { state = "code"; i++; continue; }
    if (c === "\n") out += "\n";
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name === "node_modules") continue; walk(p, acc); }
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(p)) acc.push(p);
  }
  return acc;
}

describe("corpus: shipped stripper vs. an independent reference", () => {
  const files = walk(SRC);

  it("scans a non-trivial corpus (a scan of nothing is not a pass)", () => {
    assert.ok(files.length >= 1000, `only ${files.length} source file(s) found under src/`);
  });

  it("every file's surviving CODE agrees with the reference, token for token", () => {
    // Compared with whitespace collapsed: the two algorithms legitimately
    // differ on how much whitespace a removed comment leaves behind. What must
    // not differ is WHICH CODE SURVIVES.
    const disagreements: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const a = stripComments(text).replace(/\s+/g, " ").trim();
      const b = referenceStrip(text).replace(/\s+/g, " ").trim();
      if (a !== b) disagreements.push(f.slice(SRC.length + 1));
    }
    assert.deepEqual(
      disagreements,
      [],
      "the line scanner and the character scanner disagree about what is code in these files",
    );
  });

  it("no file strips to nothing (a whole file read as comment is the bug's signature)", () => {
    const emptied: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (text.trim() === "") continue;
      if (stripComments(text).trim() === "") emptied.push(f.slice(SRC.length + 1));
    }
    assert.deepEqual(emptied, [], "these files were handed to every caller as blank");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SQL STRIPPER, held to the same contract.
//
// `stripSqlComments` in scripts/lib/canonicalSchema.ts is what makes the
// canonical SCHEMA and the canonical VOCABULARY: which tables and columns exist,
// and which labels an enum may hold. check:schema-references, check:enum-literals
// and check:not-null-writes all rest on it, so a comment counted as DDL becomes a
// column the code may name, or an enum label the code may compare against.
//
// It had the same ordering bug as its TypeScript sibling — block comments removed
// in one pass, line comments in another, so a `--` comment containing a block
// opener swallowed everything to the next close marker. Measured across all 466
// migration and baseline SQL files, that bug erases NOTHING today: no `--`
// comment in the corpus happens to contain one. It is pinned here anyway,
// because the sibling bug survived for exactly as long as nobody tested the
// stripper, and the counts before and after the fix are identical (447 tables,
// 325 columns with a declared vocabulary) which is the only reason to believe
// the change was safe.
// ─────────────────────────────────────────────────────────────────────────────
describe("stripSqlComments", () => {
  const BO = "/" + "*";
  const BC = "*" + "/";

  it("a block opener inside a `--` comment opens nothing", () => {
    const sql = [
      "CREATE TABLE a (id uuid);",
      "-- see the " + BO + " note above, and the path /assets" + BO,
      "CREATE TABLE b (id uuid);",
      BO + " a real block " + BC,
      "CREATE TABLE c (id uuid);",
    ].join("\n");
    const out = stripSqlComments(sql);
    assert.match(out, /CREATE TABLE a/);
    assert.match(out, /CREATE TABLE b/, "DDL after a line comment containing a block opener was erased");
    assert.match(out, /CREATE TABLE c/);
    assert.doesNotMatch(out, /see the/);
    assert.doesNotMatch(out, /a real block/);
  });

  it("removes an ordinary line comment and keeps the DDL before it", () => {
    assert.match(stripSqlComments("ALTER TABLE t ADD COLUMN c text; -- why"), /ALTER TABLE t ADD COLUMN c text;/);
    assert.doesNotMatch(stripSqlComments("ALTER TABLE t ADD COLUMN c text; -- why"), /why/);
  });

  it("removes a multi-line block comment", () => {
    const sql = ["CREATE TABLE a (id uuid);", BO, " * prose", " " + BC, "CREATE TABLE b (id uuid);"].join("\n");
    const out = stripSqlComments(sql);
    assert.match(out, /CREATE TABLE a/);
    assert.match(out, /CREATE TABLE b/);
    assert.doesNotMatch(out, /prose/);
  });

  it("still strips a line comment that FOLLOWS a closed block comment", () => {
    const out = stripSqlComments("CREATE TABLE a " + BO + " x " + BC + " (id uuid); -- tail");
    assert.match(out, /CREATE TABLE a/);
    assert.doesNotMatch(out, /tail/);
    assert.doesNotMatch(out, /x/);
  });

  it("an unterminated block comment runs to end of file", () => {
    const out = stripSqlComments(["CREATE TABLE a (id uuid); " + BO + " open", "CREATE TABLE b (id uuid);"].join("\n"));
    assert.match(out, /CREATE TABLE a/);
    assert.doesNotMatch(out, /CREATE TABLE b/);
  });

  it("can only ever REMOVE text, never invent it", () => {
    for (const sql of ["a -- b", BO + " a " + BC + " b", "-- " + BO + "\nCREATE TABLE keep (id uuid);"]) {
      const out = stripSqlComments(sql).replace(/\s/g, "");
      let i = 0;
      for (const ch of out) {
        i = sql.indexOf(ch, i);
        assert.notEqual(i, -1, `stripSqlComments invented ${JSON.stringify(ch)} from ${JSON.stringify(sql)}`);
        i += 1;
      }
    }
  });

  it("agrees with the two-pass version on the WHOLE real migration corpus", () => {
    // The claim that made the fix safe to make: identical output on every SQL
    // file in the tree. If a future migration introduces a `--` comment carrying
    // a block opener, this case starts failing — and that is the moment the fix
    // begins to matter, which is worth knowing about rather than discovering
    // through a wrong schema.
    const dirs = [join(SRC, "migrations"), join(SRC, "baseline")].filter((d) => existsSync(d));
    assert.ok(dirs.length > 0, "no SQL corpus found — this case would verify nothing");
    const twoPass = (sql: string) => sql.replace(new RegExp("\\" + "/\\*[\\s\\S]*?\\*\\/", "g"), " ").replace(/--[^\n]*/g, " ");
    let files = 0, disagree: string[] = [];
    for (const d of dirs) {
      for (const f of readdirSync(d)) {
        if (!f.endsWith(".sql")) continue;
        files++;
        const raw = readFileSync(join(d, f), "utf8");
        const a = stripSqlComments(raw).replace(/\s+/g, " ").trim();
        const b = twoPass(raw).replace(/\s+/g, " ").trim();
        if (a !== b) disagree.push(f);
      }
    }
    assert.ok(files >= 400, `only ${files} SQL file(s) scanned — the corpus check is vacuous`);
    assert.deepEqual(disagree, [], "a `--` comment now carries a block opener; the order-aware stripper is load-bearing from here");
  });
});
