/**
 * clientLetterFoldParity — census-discovery §76 (lane P34): the client's
 * letter-fold table is the server's, entry for entry, so the two cannot drift.
 *
 * The server folds stroke/hook/bar letters for the canonical search key with
 * `lib/latinLetterFold.LATIN_LETTER_FOLD` (§73, 257 entries generated from
 * UnicodeData.txt). The client's place-name lookup (`getCityCentroid`, which
 * places a Passport memory's typed city on the Memories map) folded six letters
 * of its own. §76 copies the table into
 * `travel-buddy-standalone/src/lib/latinLetterFold.ts`, because the app bundle
 * cannot import from artifacts/api-server. This file is what makes the copy
 * safe: any added, dropped, re-valued or re-ordered entry on either side fails
 * P1, and P2 fails if the client lookup stops using the copy.
 *
 * THE MARK RULE (added at the integrator's instruction, after census §74). The
 * server's combining-mark strip is inline in canonicalLocations'
 * normalizeLocationName and is not exported, so P3 compares the two BY
 * BEHAVIOUR, importing both: for every code point that is a mark or carries
 * the `Diacritic` property, "a<mark>b" through the server's `searchKey` and
 * through the client's `stripCombiningMarks` (on the NFD form, as the lookup
 * applies it) must agree on whether the mark is removed. Both now strip the
 * four Latin combining blocks whole (census §77). P3 was RED on 46 marks (the
 * blocks' non-Diacritic marks) while the client followed §74's Diacritic-only
 * class, and went green when the client took §77's rule; P4 also compares the
 * two patterns by value, since the server now exports LATIN_MARKS_RE.
 *
 *   P1  the two tables are identical: same keys, same values, same order
 *   P2  the client's lookup folds with that table and strip, after NFD
 *   P3  the client's mark strip removes exactly the marks the server's key removes
 *   P4  the client's mark pattern is the server's LATIN_MARKS_RE, by value
 *
 * Runtime: node:test + node:assert/strict.
 * Run: node --import tsx/esm --test src/test/clientLetterFoldParity.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LATIN_LETTER_FOLD as SERVER, LATIN_MARKS_RE } from "../lib/latinLetterFold.js";
import { searchKey } from "../lib/canonicalLocations.js";
import { LATIN_LETTER_FOLD as CLIENT, stripCombiningMarks, COMBINING_MARK_RE } from "../../../../travel-buddy-standalone/src/lib/latinLetterFold.ts";

const CLIENT_LOOKUP = new URL("../../../../travel-buddy-standalone/src/lib/cityCentroids.ts", import.meta.url);

describe("§76 — the client folds letters with the server's table", () => {
  it("P1. the client table is the server table: same keys, same values, same order", () => {
    assert.equal(Object.keys(SERVER).length, 257, "the server table §73 generated");
    assert.deepEqual(Object.entries(CLIENT), Object.entries(SERVER));
  });

  it("P2. the client lookup imports that table and applies it after NFD", () => {
    const src = readFileSync(CLIENT_LOOKUP, "utf8");
    assert.match(src, /import \{ LATIN_LETTER_FOLD, stripCombiningMarks \} from '\.\/latinLetterFold\.ts';/, "cityCentroids imports the copy");
    const fn = src.slice(src.indexOf("function normaliseCityKey("), src.indexOf("function normaliseCityKey(") + 400);
    const nfd = fn.indexOf(".normalize('NFD')"), fold = fn.indexOf("LATIN_LETTER_FOLD[c]");
    assert.ok(nfd > 0 && fold > nfd, "normaliseCityKey decomposes first, then folds with the table");
    assert.match(fn, /stripCombiningMarks\(/, "normaliseCityKey strips marks with the shared rule");
    assert.doesNotMatch(src, /STROKED_TRANSLIT|\[ŁłØøĐđ\]/u, "the six-letter table is gone");
  });

  it("P3. the client's mark strip removes exactly the marks the server's search key removes", () => {
    const differ: string[] = [];
    for (let c = 0; c <= 0x10ffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      const m = String.fromCodePoint(c);
      if (!/\p{M}|\p{Diacritic}/u.test(m)) continue;
      const server = searchKey("a" + m + "b") === "ab";
      const client = stripCombiningMarks(("a" + m + "b").normalize("NFD")) === "ab";
      if (server !== client) differ.push(`U+${c.toString(16).toUpperCase()} server ${server ? "strips" : "keeps"}, client ${client ? "strips" : "keeps"}`);
    }
    assert.deepEqual(differ.slice(0, 12), [], `${differ.length} code points fold differently`);
  });
  it("P4. the client's mark pattern is the server's LATIN_MARKS_RE, by value", () => {
    assert.equal(COMBINING_MARK_RE.source, LATIN_MARKS_RE.source);
    assert.equal(COMBINING_MARK_RE.flags, LATIN_MARKS_RE.flags);
  });
});
