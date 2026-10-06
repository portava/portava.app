/**
 * CENSUS_STALENESS_ACKNOWLEDGED.json has exactly ONE byte form.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION
 * =======================================
 * Every lane that changes a file a census watches appends to this ledger, so
 * it is the most-edited file in the repository and every open branch carries a
 * copy. It is JSON, and JSON has more than one spelling for the same value: the
 * box-drawing rule that opens most entries can be written as the characters
 * themselves or as `\u2500` escapes. Both parse to the same thing.
 *
 * Between 2026-10-04 and 2026-10-05 the file changed spelling three times:
 *
 *   - PR #596 edited one entry with a load-and-dump, which escaped every
 *     non-ASCII character in the file: 28 untouched lines changed.
 *   - A branch that had not yet merged that restored the characters.
 *   - PR #588, carrying the older spelling, merged and put the characters back
 *     on main.
 *
 * No meaning changed on any of those days. Every flip made every open branch
 * conflict with main on lines nobody had edited, and one integration branch
 * conflicted in seven hunks for that reason alone. A convention cannot hold
 * here, because the two spellings are indistinguishable to `check:census-
 * freshness`, to a reviewer reading the diff as prose, and to the author's own
 * editor — the only thing that can tell them apart is a byte comparison.
 *
 * THE FORM
 * ========
 * `JSON.stringify(value, null, 2)`, every non-ASCII UTF-16 code unit written as
 * a lower-case `\uXXXX` escape, one trailing newline. That is byte-for-byte
 * what Python's `json.dumps(value, indent=2, ensure_ascii=True) + "\n"`
 * produces, which matters because the lanes edit this file from both
 * languages. The escaped spelling is chosen over the raw one for one reason:
 * it is the output of a standard serialiser with standard options, so "load,
 * change one entry, dump" reproduces every other line exactly. The raw spelling
 * this replaced was NOT any serialiser's output — it mixed raw characters with
 * four stray escapes — so nothing could regenerate it.
 *
 * TO FIX A FAILURE: re-serialise the file; do not hand-edit it.
 *   python3 -c "import json,io;p='artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json';d=json.load(io.open(p,encoding='utf-8'));io.open(p,'w',encoding='utf-8').write(json.dumps(d,indent=2,ensure_ascii=True)+'\n')"
 *
 * WHAT THIS DOES NOT COVER: anything the ledger SAYS. Whether an entry's
 * argument is sound, whether it names the files that changed — those are
 * `check:census-freshness`'s and a reader's. This pins spelling only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const LEDGER = resolve(__dir, "../scripts/CENSUS_STALENESS_ACKNOWLEDGED.json");

/** The one spelling. See the header for why this one. */
function canonicalForm(value: unknown): string {
  const raw = JSON.stringify(value, null, 2);
  const escaped = raw.replace(/[\u0080-\uffff]/g, (unit) => "\\u" + unit.charCodeAt(0).toString(16).padStart(4, "0"));
  return `${escaped}\n`;
}

describe("CENSUS_STALENESS_ACKNOWLEDGED.json — one byte form", () => {
  it("the serialiser matches Python's json.dumps(indent=2, ensure_ascii=True) on the shapes this file uses", () => {
    // Written out by hand rather than generated, so a change to `canonicalForm`
    // cannot also change what it is compared against. The value exercises a
    // box-drawing character, an accented letter, a section sign, an escaped
    // newline and quote inside a string, a nested array and an empty one.
    const value = { "//": ["a\u2500b"], acknowledged: [{ census: "c.md", files: ["x.ts"], reason: "\u00a7 1\n\"q\" \u00e9" }], retired: [] };
    const expected =
      '{\n' +
      '  "//": [\n' +
      '    "a\\u2500b"\n' +
      '  ],\n' +
      '  "acknowledged": [\n' +
      '    {\n' +
      '      "census": "c.md",\n' +
      '      "files": [\n' +
      '        "x.ts"\n' +
      '      ],\n' +
      '      "reason": "\\u00a7 1\\n\\"q\\" \\u00e9"\n' +
      '    }\n' +
      '  ],\n' +
      '  "retired": []\n' +
      '}\n';
    assert.equal(canonicalForm(value), expected);
  });

  it("the committed ledger is in that form, byte for byte", () => {
    const text = readFileSync(LEDGER, "utf8");
    const canonical = canonicalForm(JSON.parse(text));
    if (text !== canonical) {
      // Report WHERE, because the file is megabytes long and a bare inequality
      // would print all of it twice.
      const a = text.split("\n");
      const b = canonical.split("\n");
      let line = 0;
      while (line < a.length && line < b.length && a[line] === b[line]) line++;
      const differing = a.reduce((n, l, i) => n + (l === b[i] ? 0 : 1), 0) + Math.abs(a.length - b.length);
      assert.fail(
        `CENSUS_STALENESS_ACKNOWLEDGED.json is not in its canonical form: ${differing} line(s) differ, the first at line ${line + 1}. ` +
          "The meaning may be identical — this is about spelling. Re-serialise the file with the command in this test's header; do not hand-edit it. " +
          `Line ${line + 1} begins: ${JSON.stringify((a[line] ?? "").slice(0, 80))}; canonical begins: ${JSON.stringify((b[line] ?? "").slice(0, 80))}`,
      );
    }
  });

  it("CONTROL — the comparison can fail: the ledger really holds non-ASCII text, and its raw spelling is a different string", () => {
    // Without this, the test above is also satisfied by a ledger with nothing
    // to escape, in which case the two spellings coincide and it pins nothing.
    const value = JSON.parse(readFileSync(LEDGER, "utf8")) as unknown;
    const rawSpelling = `${JSON.stringify(value, null, 2)}\n`;
    assert.match(rawSpelling, /[\u0080-\uffff]/, "the ledger no longer contains any non-ASCII character — this guard has nothing to distinguish");
    assert.notEqual(rawSpelling, canonicalForm(value), "the raw and canonical spellings coincide, so the byte comparison above cannot fail");
  });

  it("no raw non-ASCII byte reaches the file", () => {
    // The direct statement of the property, independent of the serialiser: if
    // someone changes `canonicalForm` and the file together, this still holds
    // the line.
    const text = readFileSync(LEDGER, "utf8");
    const hit = /[\u0080-\uffff]/.exec(text);
    assert.equal(hit, null, hit ? `raw non-ASCII character U+${hit[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} at offset ${hit.index}` : "");
  });
});
