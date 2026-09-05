/**
 * §28 acceptance-test TRACEABILITY — the mapping cannot rot silently.
 *
 * Every AT-01 … AT-18 scenario in Table 36 has real coverage in this suite, but
 * for fourteen of them that coverage was invisible: the tests were named after
 * the module they exercise, so a rename, a deletion, or a refactor could drop a
 * spec-level guarantee with no signal. This file closes that hole.
 *
 * WHAT IT PROVES, PRECISELY
 * ========================
 * That every id in lib/intelAcceptanceTests.INTEL_ACCEPTANCE_TESTS appears in
 * at least one TEST TITLE — a `describe(...)` or `it(...)` string — somewhere
 * under src/test. That is deliberately a weak claim: it proves a labelled test
 * exists, NOT that the test asserts the right thing. It is, however, exactly
 * the claim that decays without anyone noticing, and it cannot decay now.
 *
 * WHY TITLES AND NOT COMMENTS
 * ===========================
 * The scan reads only quoted `describe(`/`it(` titles. A comment mentioning
 * AT-11 does not count, because a comment survives the deletion of the test it
 * describes — which is the exact failure mode this guard exists to catch. It
 * also refuses an id NOT in the registry, so a typo ("AT-19", "AT-1") reads as a
 * mistake rather than as coverage.
 *
 * Runtime: node:test. Run: node --import tsx/esm --test src/test/intelAcceptanceTraceability.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  INTEL_ACCEPTANCE_TESTS,
  INTEL_ACCEPTANCE_TEST_IDS,
} from "../lib/intelAcceptanceTests.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** This file itself: it names every id (in the registry import + assertions),
 *  so counting it would make the check trivially pass forever. */
const SELF = "intelAcceptanceTraceability.test.ts";

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) testFiles(full, out);
    else if (entry.name.endsWith(".test.ts") && entry.name !== SELF) out.push(full);
  }
  return out;
}

/**
 * Every `describe("…")` / `it("…")` title in a source file. Single-line titles
 * only — which is how every title in this suite is written, and keeping the
 * scanner simple is what keeps it honest: it cannot accidentally match a
 * comment, an import, or a variable that happens to contain "AT-nn".
 */
function titlesIn(source: string): string[] {
  const out: string[] = [];
  const re = /\b(?:describe|it)\(\s*(["'`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[2]);
  return out;
}

/** id → the test titles that claim it. */
function buildTraceability(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of testFiles(HERE)) {
    const source = readFileSync(file, "utf8");
    for (const title of titlesIn(source)) {
      for (const m of title.matchAll(/\bAT-(\d{2})\b/g)) {
        const id = `AT-${m[1]}`;
        const list = found.get(id) ?? [];
        list.push(`${file.slice(HERE.length + 1)} :: ${title}`);
        found.set(id, list);
      }
    }
  }
  return found;
}

describe("§28 acceptance-test registry", () => {
  it("registers exactly AT-01 … AT-18, once each, in Table-36 order", () => {
    assert.equal(INTEL_ACCEPTANCE_TESTS.length, 18);
    assert.deepEqual(
      INTEL_ACCEPTANCE_TEST_IDS,
      Array.from({ length: 18 }, (_, i) => `AT-${String(i + 1).padStart(2, "0")}`),
    );
    assert.equal(new Set(INTEL_ACCEPTANCE_TEST_IDS).size, 18);
  });

  it("carries a scenario and a required assertion for every id", () => {
    for (const t of INTEL_ACCEPTANCE_TESTS) {
      assert.ok(t.scenario.length > 0, `${t.id} needs its Table-36 scenario`);
      assert.ok(t.requiredAssertion.length > 0, `${t.id} needs its Table-36 assertion`);
    }
  });
});

describe("§28 traceability — every acceptance id maps to a labelled test", () => {
  const found = buildTraceability();

  it("finds at least one labelled test title for every registered id", () => {
    const unmapped = INTEL_ACCEPTANCE_TEST_IDS.filter((id) => (found.get(id)?.length ?? 0) === 0);
    assert.deepEqual(
      unmapped,
      [],
      `these acceptance ids have no labelled test: ${unmapped.join(", ")}. `
      + "Put the id in the TITLE of the test that asserts it (not in a comment).",
    );
  });

  it("finds no AT id that is not in the registry (a typo is a mistake, not coverage)", () => {
    const registered = new Set(INTEL_ACCEPTANCE_TEST_IDS);
    const strays = [...found.keys()].filter((id) => !registered.has(id));
    assert.deepEqual(strays, [], `unregistered acceptance ids in test titles: ${strays.join(", ")}`);
  });

  it("reads TITLES only — an id in a comment is not coverage", () => {
    // The scanner is the thing being checked here: a file that mentions an id
    // only in prose must contribute nothing.
    const commentOnly = `
      // AT-99 is thoroughly covered, honest.
      /** AT-99 again, in a doc block. */
      const label = "AT-99 in a bare string";
      describe("something unrelated", () => {
        it("does a thing", () => {});
      });
    `;
    const titles = titlesIn(commentOnly);
    assert.deepEqual(titles, ["something unrelated", "does a thing"]);
    assert.ok(!titles.join(" ").includes("AT-99"));
  });

  it("does count an id that IS in a title", () => {
    const titles = titlesIn(`it("AT-07: two sides in conflict", () => {});`);
    assert.deepEqual(titles, ["AT-07: two sides in conflict"]);
  });

  it("does not count itself — the traceability file is excluded from the scan", () => {
    for (const file of testFiles(HERE)) {
      assert.ok(!file.endsWith(SELF), "the scan must skip its own file");
    }
  });
});
