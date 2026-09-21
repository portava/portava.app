/**
 * The id grammar in `checkCensusIntegrity.ts`, one case per shape it must read.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 * Three architecture lanes hit the same parser defect independently, on the
 * same afternoon, and fixed it three incompatible ways: one patched the parser,
 * one renamed its row ids to dodge it, and one wrote ten cells to be DECLINED
 * rather than mis-expanded. Three workarounds for one bug is what an untested
 * parser buys.
 *
 * The defect class is always the same and always silent. `parseIdCell` assumed
 * an id is CAPITALS then a NUMBER, so:
 *
 *   - `TRV2-03` read as prefix `TRV`, number `2`, range separator `-03`, and
 *     expanded ONE requirement into the invented ids TRV2 … TRV3. `TRV2-11`
 *     expanded into ten. Last-statement-wins then overwrote each expansion, and
 *     a `CV` row disappeared into nine fabricated `C`s — the tally read four
 *     more correct rows than the document claimed, IN ITS OWN FAVOUR.
 *   - `C1-02` collapsed six distinct rows onto one id.
 *   - `TV-P1` … `TV-P5`, a lettered series, matched nothing: five privacy
 *     invariants invisible to the tallier while the census counted them.
 *   - `CPH-EVAL`, a named id with no digits anywhere, was dropped the same way.
 *
 * Every one of those is a machine disagreeing with a census and saying nothing.
 * A percentage computed from a parse that drops rows is not reproducible, it is
 * merely repeatable, and the two are not the same thing.
 *
 * ── WHY A FIXTURE, WHEN THE SIBLING TEST USES THE REAL CORPUS ───────────────
 * `censusIntegrityQualifiedVerdicts.test.ts` spawns this script against the
 * real `docs/architecture/` and is right to: it is asking whether the tool
 * agrees with documents people actually wrote. That is the wrong instrument for
 * a GRAMMAR, because the real corpus cannot be made to contain a cell on
 * demand, and pinning a real census's row count would fail every time someone
 * legitimately adds a row.
 *
 * So this drives the SAME script through `CENSUS_INTEGRITY_DIR`, a seam that
 * changes which directory is read and nothing else. Every floor still applies
 * to the fixture — that is why it carries ten censuses, not one. CI runs
 * `check:census-integrity` with the seam UNSET, against the real tree; this is
 * an additional test, never the only reach, which is the failure mode
 * `guardRegistry.ts` exists to prevent.
 *
 * The fixture is arithmetic anyone can check by hand: ten id cells that must
 * yield thirteen ids, and one prose cell that must yield none.
 *
 *   GR-01 · GR-02                      2 plain ids
 *   GRV2-01 · GRV2-11                  2 digit-bearing prefixes, NOT ranges
 *   G1-07                              1 one-letter prefix ending in a digit
 *   GR-P1 · GR-P5                      2 lettered-series ids
 *   GR-EVAL                            1 named id, no digits at all
 *   GR-10–GR-12                        3 — a genuine range, still expanded
 *   GR-20, GR-21                       2 — a comma list, still expanded
 *   "Not an id at all, just prose…"    0 — prose stays out
 *                                     ── 13
 *
 * Run: CENSUS_INTEGRITY_DIR=<fixture> node --import tsx/esm --test src/test/censusIdGrammar.test.ts
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/checkCensusIntegrity.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/censusIdGrammar/", import.meta.url));
const GRAMMAR_MD = fileURLToPath(new URL("./fixtures/censusIdGrammar/census-grammar.md", import.meta.url));

function run(dir?: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--import", "tsx/esm", SCRIPT], {
    encoding: "utf8",
    env: dir ? { ...process.env, CENSUS_INTEGRITY_DIR: dir } : { ...process.env },
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** The `grammar` row of the tool's per-census table: rows, C, W, N, X. */
function grammarCounts(out: string): { rows: number; c: number; w: number; n: number; x: number } {
  const line = out.split("\n").find((l) => /^\s+grammar\s+\d/.test(l));
  assert.ok(line, `no 'grammar' row in the tool's output:\n${out}`);
  const f = line!.trim().split(/\s+/);
  return { rows: Number(f[1]), c: Number(f[2]), w: Number(f[3]), n: Number(f[4]), x: Number(f[5]) };
}

let fixtureOut = "";
before(() => {
  const r = run(FIXTURE);
  assert.equal(r.status, 0, `the fixture run must pass its own floors:\n${r.out}`);
  fixtureOut = r.out;
});

describe("the premise — every shape really is written in the fixture", () => {
  // Asserted rather than assumed. If someone reformats the fixture, these fail
  // loudly instead of letting the arithmetic below pass for the wrong reason.
  const md = readFileSync(GRAMMAR_MD, "utf8");
  for (const cell of ["| GRV2-01 |", "| GRV2-11 |", "| G1-07 |", "| GR-P1 |", "| GR-P5 |",
                      "| GR-EVAL |", "| GR-10–GR-12 |", "| GR-20, GR-21 |"]) {
    it(`the fixture contains the cell ${cell.trim()}`, () => {
      assert.ok(md.includes(cell), `${cell} is not in the fixture any more`);
    });
  }
});

describe("every id shape parses, and prose still does not", () => {
  it("thirteen ids from ten id cells — the whole grammar in one number", () => {
    assert.equal(grammarCounts(fixtureOut).rows, 13,
      "a shape regressed: 2 plain + 2 digit-prefixed + 1 digit-suffixed-prefix + " +
      "2 lettered + 1 named + 3 range + 2 list = 13, and prose contributes 0");
  });

  it("the verdicts land where the fixture puts them, so no id was silently reassigned", () => {
    const g = grammarCounts(fixtureOut);
    assert.deepEqual({ c: g.c, w: g.w, n: g.n, x: g.x }, { c: 9, w: 3, n: 1, x: 0 },
      "C = GR-01, GRV2-01, G1-07, GR-P1, GR-10..12, GR-20..21; " +
      "W = GR-02, GRV2-11, GR-EVAL; N = GR-P5");
  });

  it("a digit-bearing prefix is ONE id, not a range — the defect that read four rows in its own favour", () => {
    // If GRV2-01 and GRV2-11 expanded as ranges they would contribute at least
    // twelve ids between them and the total could not be 13.
    assert.equal(grammarCounts(fixtureOut).rows, 13);
    assert.ok(!/GRV3|GRV4/.test(fixtureOut), "an id was invented that the fixture never wrote");
  });

  it("a genuine range still expands — the fix must not have closed ranges to close the bug", () => {
    // The control. Without it every assertion above is satisfied by a parser
    // that simply stopped expanding anything, which would silently shrink every
    // census in the corpus that uses range cells.
    const g = grammarCounts(fixtureOut);
    assert.equal(g.rows, 13);
    assert.equal(g.c, 9, "GR-10–GR-12 and GR-20, GR-21 contribute five of the nine C ids");
  });
});

describe("the seam cannot become the only way this tool runs", () => {
  it("with CENSUS_INTEGRITY_DIR unset the tool reads the real corpus and passes", () => {
    const r = run();
    assert.equal(r.status, 0, `the real-tree run is what CI gates on:\n${r.out}`);
    assert.ok(/census file\(s\) read/.test(r.out), "the real run must still report what it read");
    assert.ok(!/^\s+grammar\s/m.test(r.out), "the fixture must not be reachable from the real tree");
  });
});
