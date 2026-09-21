/**
 * census-compass CC-05 — the tool count in `CompassTools.ts`'s header, made
 * executable.
 *
 * THE CLAIM HAS BEEN WRONG THREE TIMES AND WAS FIXED TWICE BY EDITING A WORD.
 *   • It read "Eight tools the model may call" while eleven were declared.
 *     census-compass §3 scored CC-05 W, and the fix was to write "eleven".
 *   • One week later it read "Fourteen" while THIRTY-THREE were declared —
 *     twenty-five in `COMPASS_TOOL_DEFINITIONS` plus the eight
 *     `TELEGRAPH_COMPASS_TOOL_DEFINITIONS` spread into it. The row that had
 *     just been marked BUILT-AND-CORRECT was wrong again, by nineteen.
 *
 * Editing the word fixes the instance. The class is that a count in a comment
 * decays whenever a tool is added and NOTHING IN THE TREE CAN NOTICE — the same
 * defect `check-doc-citations.mjs` exists for, one layer in. So the count is
 * asserted here, in both halves:
 *
 *   1. `COMPASS_TOOL_COUNT_IN_HEADER` equals `COMPASS_TOOL_DEFINITIONS.length`.
 *      Adding or removing a tool without updating the constant is now RED.
 *   2. The number WORD in the header sentence parses to that same constant.
 *      Updating the constant without the prose (or the prose without the
 *      constant) is now RED. Without this half the header could still lie while
 *      a green constant sat underneath it, which is exactly the shape of the
 *      failure being closed.
 *
 * WHAT WOULD MAKE THIS GREEN AND STILL WRONG (P24): a tool declared somewhere
 * the dispatcher reaches but `COMPASS_TOOL_DEFINITIONS` does not contain. C3
 * closes that from the other side — every dispatchable name must be in the
 * definitions, so a tool the model can call but the count cannot see fails.
 *
 * SHOWN RED before commit — each mutation applied, watched fail, reverted, and
 * the file compared byte-for-byte with its backup. See
 * docs/architecture/census-compass.md §10.
 *
 * Run: node --import tsx/esm --test src/test/compassToolCountContract.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COMPASS_TOOL_DEFINITIONS,
  COMPASS_TOOL_COUNT_IN_HEADER,
  COMPASS_TOOL_NAMES,
} from "../compass/CompassTools.js";

const SOURCE = new URL("../compass/CompassTools.ts", import.meta.url).pathname;

/** English number words 1-99, enough for a tool count and no more. */
const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

export function parseNumberWord(raw: string): number | null {
  const w = raw.trim().toLowerCase();
  if (/^\d+$/.test(w)) return Number(w);
  if (UNITS[w] !== undefined) return UNITS[w]!;
  const m = /^([a-z]+)[-\s]([a-z]+)$/.exec(w);
  if (m && TENS[m[1]!] !== undefined && UNITS[m[2]!] !== undefined) return TENS[m[1]!]! + UNITS[m[2]!]!;
  if (TENS[w] !== undefined) return TENS[w]!;
  return null;
}

/** The header's own sentence: "<count> tools the model may call on demand". */
function headerToolCount(): { word: string; value: number | null } {
  const head = readFileSync(SOURCE, "utf8").slice(0, 4000);
  const m = /\*\s*([A-Za-z-]+|\d+)\s+tools the model may call on demand/.exec(head);
  assert.ok(m, "the header no longer states '<count> tools the model may call on demand' — the claim this test pins is gone, which is a change to make deliberately, not by deleting a sentence");
  return { word: m[1]!, value: parseNumberWord(m[1]!) };
}

describe("CC-05 — the header's tool count is checked, not asserted", () => {
  it("C1 — the constant equals the number of declared tools", () => {
    assert.equal(
      COMPASS_TOOL_COUNT_IN_HEADER,
      COMPASS_TOOL_DEFINITIONS.length,
      "a tool was added or removed without updating COMPASS_TOOL_COUNT_IN_HEADER",
    );
  });

  it("C2 — the header's number word parses to the same constant", () => {
    const { word, value } = headerToolCount();
    assert.notEqual(value, null, `the header says "${word}", which is not a number this test can read`);
    assert.equal(value, COMPASS_TOOL_COUNT_IN_HEADER, `the header says "${word}" (${value}) and the constant says ${COMPASS_TOOL_COUNT_IN_HEADER}`);
  });

  it("C3 — every dispatchable tool name is one the count can see", () => {
    const declared = new Set(COMPASS_TOOL_DEFINITIONS.map((t) => t.function.name));
    assert.equal(COMPASS_TOOL_NAMES.size, declared.size);
    for (const n of COMPASS_TOOL_NAMES) {
      assert.ok(declared.has(n), `${n} is dispatchable but not in COMPASS_TOOL_DEFINITIONS, so the count cannot see it`);
    }
  });

  it("C4 — no tool name is declared twice (a duplicate would hide one from the count)", () => {
    const names = COMPASS_TOOL_DEFINITIONS.map((t) => t.function.name);
    assert.equal(new Set(names).size, names.length, `duplicate tool name(s): ${names.filter((n, i) => names.indexOf(n) !== i).join(", ")}`);
  });

  it("C5 — the word parser itself is right, so C2 cannot pass by failing to read", () => {
    assert.equal(parseNumberWord("eight"), 8);
    assert.equal(parseNumberWord("eleven"), 11);
    assert.equal(parseNumberWord("fourteen"), 14);
    assert.equal(parseNumberWord("thirty-three"), 33);
    assert.equal(parseNumberWord("Thirty-three"), 33);
    assert.equal(parseNumberWord("forty"), 40);
    assert.equal(parseNumberWord("33"), 33);
    assert.equal(parseNumberWord("several"), null);
  });
});
