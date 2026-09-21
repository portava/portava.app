/**
 * A verdict with a qualifier is still a verdict.
 *
 * WHAT THIS IS ABOUT
 * ==================
 * `checkCensusIntegrity.ts` prints, per census, how many requirements are
 * "counted where this tool cannot read". The phrase means PROSE — a paragraph
 * enumerating several requirements at once, which is a legitimate way to count
 * them and an impossible one to parse. census-map reported 4, and a reader
 * would reasonably conclude four of its requirements lived in a paragraph.
 *
 * They did not. M47, M169, M176 and M177 are ordinary table rows. Their verdict
 * cell reads `C *(not spec-attributable)*` — the verdict, then a parenthesised
 * note saying the artifact predates the Map spec and so does not count toward
 * that census's ATTRIBUTION percentage. The tokeniser accepted `⌀` and `†` as
 * qualifiers and rejected this one, so the four rows parsed as nothing at all:
 * the tool reported C 231 against a document whose own headline says 235, and
 * the discrepancy was invisible because it surfaced as an unreconciled-prose
 * number rather than as a disagreement.
 *
 * THIS IS A COUNTING FIX, NOT A CORRECTNESS FIX, and the distinction is the
 * whole reason this file says so out loud. Nothing was built. No requirement
 * changed state. The four rows were always C in the document; they are now C in
 * the recount too. The CONSTRUCTED-minus-CORRECT gap is W/denominator and is
 * untouched by this — 48/293 before, 48/293 after.
 *
 * WHY IT IS TESTED BY RUNNING THE REAL SCRIPT
 * ===========================================
 * The tokeniser is module-private, and a test that re-implemented it would be
 * two copies of the same opinion agreeing with each other — the exact failure
 * `serverSearchTypes.test.ts` was written to escape. So this runs
 * `checkCensusIntegrity.ts` as the check does and reads its output.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/censusIntegrityQualifiedVerdicts.test.ts
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/checkCensusIntegrity.ts", import.meta.url));
const CENSUS_MAP = fileURLToPath(new URL("../../../../docs/architecture/census-map.md", import.meta.url));

interface Row { rows: number; c: number; w: number; n: number; x: number; denom: number; unreconciled: number }

let output = "";

function rowFor(census: string): Row {
  const line = output.split("\n").find((l) => new RegExp(`^\\s+${census}\\s+\\d`).test(l));
  assert.ok(line, `no line for census "${census}" in the tool's output — has the report shape changed?`);
  const m = /^\s+\S+\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+) counted/.exec(line);
  assert.ok(m, `could not parse the ${census} line: ${line}`);
  const [, rows, c, w, n, x, denom, unreconciled] = m as unknown as string[];
  return { rows: +rows!, c: +c!, w: +w!, n: +n!, x: +x!, denom: +denom!, unreconciled: +unreconciled! };
}

before(() => {
  const run = spawnSync(process.execPath, ["--import", "tsx/esm", SCRIPT], { encoding: "utf8" });
  output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.equal(run.status, 0, `checkCensusIntegrity exited ${run.status}:\n${output}`);
});

describe("the tool reads census-map's qualified verdicts", () => {
  it("the four rows really are written with a qualifier — the premise, not an assumption", () => {
    // If the census is reformatted, this test is about a problem that no longer
    // exists and should be deleted rather than quietly passing.
    const src = readFileSync(CENSUS_MAP, "utf8");
    for (const id of ["M47", "M169", "M176", "M177"]) {
      const line = src.split("\n").find((l) => l.startsWith(`| ${id} |`) && l.includes("spec-attributable"));
      assert.ok(line, `${id} no longer carries a "(not spec-attributable)" verdict cell`);
      assert.match(line, /\|\s*C \*\(not spec-attributable\)\*\s*\|/);
    }
  });

  it("every requirement in census-map's denominator is parsed — no prose gap left", () => {
    const map = rowFor("map");
    assert.equal(map.denom, 293);
    assert.equal(map.rows, 293, "census-map still has rows the tool cannot read");
    assert.equal(map.unreconciled, 0);
  });

  it("the recount agrees with the document's own headline, bucket for bucket", () => {
    // Compared against the DOCUMENT, never against literals. Later passes move
    // rows, and a test pinning 235/48 would go red for the wrong reason the
    // first time one did. The invariant worth holding is that the recount and
    // the headline describe the same table — decidable only because the four
    // rows below closed the prose gap.
    const map = rowFor("map");
    const src = readFileSync(CENSUS_MAP, "utf8");
    const bucket = (label: string): number => {
      const rows = [...src.matchAll(new RegExp(String.raw`^\|\s*\*{0,2}${label}\*{0,2}\s*((?:\|[^|\n]*)+)\|\s*$`, "gm"))];
      assert.ok(rows.length > 0, `no headline row for ${label}`);
      const nums = [...rows[rows.length - 1]![1]!.matchAll(/\*{0,2}([0-9]{1,4})\*{0,2}/g)].map((m) => Number(m[1]));
      return nums[nums.length - 1]!;
    };
    assert.deepEqual(
      { c: map.c, w: map.w, n: map.n, x: map.x },
      {
        c: bucket("BUILT-AND-CORRECT"),
        w: bucket("BUILT-BUT-WRONG"),
        n: bucket("NOT-BUILT"),
        x: bucket("CANNOT-VERIFY"),
      },
    );
    assert.equal(map.c + map.w + map.n + map.x, map.denom);
  });

  it("this changed the COUNT and not the gap — every row it added was already C", () => {
    // Why a counting fix can never be banked as correctness, as an assertion
    // rather than a promise: all four rows the tokeniser started reading carry
    // verdict C, so reading them moves the C bucket and leaves W untouched —
    // and CONSTRUCTED minus CORRECT *is* W / denominator.
    const src = readFileSync(CENSUS_MAP, "utf8");
    for (const id of ["M47", "M169", "M176", "M177"]) {
      const line = src.split("\n").find((l) => l.startsWith(`| ${id} |`) && l.includes("spec-attributable"));
      assert.ok(line, `${id} row not found`);
      assert.match(line, /\|\s*C \*\(not spec-attributable\)\*\s*\|/, `${id} is no longer C`);
    }
    const map = rowFor("map");
    const constructed = (map.c + map.w) / map.denom;
    const correct = map.c / map.denom;
    assert.ok(Math.abs(constructed - correct - map.w / map.denom) < 1e-12);
  });

  it("no other census can gain or lose a requirement to this change", () => {
    // ── THIS CASE USED TO BE A SNAPSHOT, AND THE SNAPSHOT WAS THE BUG ───────
    //
    // It asserted six censuses' absolute C/W/N/X against a frozen table
    // labelled "these are the pre-change figures". The CLAIM was right — the
    // tokeniser change moves no census but map — but a snapshot of the EFFECT
    // can only stay green if the corpus never changes again, so it went red
    // the moment compass legitimately moved 61/23/6 -> 69/18/3 on four W->C
    // builds and two deliberate N->W re-reads. `deepEqual` throws on the first
    // mismatch, so discovery, layover and trips were failing behind it unseen.
    //
    // Bumping the integers would have made the numbers green without making
    // the claim true, and would have re-armed the identical trap for the next
    // lane that moves a row. The claim is proved from its CAUSE instead: the
    // tokeniser change recognises ONE new cell shape, a verdict followed by a
    // parenthesised italic qualifier. If no census except map contains that
    // shape, the change cannot reach another census — and unlike a count, that
    // stays true as censuses move.
    const dir = fileURLToPath(new URL("../../../../docs/architecture/", import.meta.url));
    const censuses = readdirSync(dir).filter((f) => /^census-.*\.md$/.test(f)).sort();
    assert.ok(censuses.length >= 13, `expected the full census corpus, found ${censuses.length}`);

    /** A verdict cell carrying a parenthesised italic qualifier: `| C *(…)*`. */
    const QUALIFIED_CELL = /\|\s*[CWNX]\s+\*\([^)]*\)\*/g;
    const byCensus = new Map<string, number>();
    for (const f of censuses) {
      const hits = readFileSync(dir + f, "utf8").match(QUALIFIED_CELL) ?? [];
      if (hits.length > 0) byCensus.set(f, hits.length);
    }

    assert.deepEqual(
      [...byCensus.entries()],
      [["census-map.md", 4]],
      "a census other than map now carries a verdict cell with a parenthesised qualifier, " +
        "so the tokeniser change is no longer provably scoped to map — re-derive that census " +
        "and say what moved, rather than widening this expectation",
    );

    // And the four are the rows the fix was written for, still reported as
    // parsed rather than as unreadable prose.
    const map = rowFor("map");
    assert.equal(map.c + map.w + map.n + map.x + map.unreconciled, map.denom,
      "census-map's parsed rows plus its unreconciled prose must still account for its denominator");
  });
});
