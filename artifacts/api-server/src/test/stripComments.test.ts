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
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../scripts/lib/stripComments.js";

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
