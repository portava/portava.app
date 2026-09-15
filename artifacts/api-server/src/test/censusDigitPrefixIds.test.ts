/**
 * `parseIdCell` and the DIGIT-SUFFIX PREFIX — the shape that cost census-
 * discovery three machine-checkable rows, pinned so it cannot cost them again.
 *
 * ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
 * `docs/architecture/reconciled-baseline-v1.md` §2.2 records three graded
 * Discovery requirements — `DSV2-04` **N**, `DSV2-05` **C**, `DSV2-12` **N** —
 * that were written in census PROSE rather than in a verdict table, because an
 * id of the shape `DSV2-nn` risked parsing as a line RANGE. census-discovery
 * §11.13 measured the failure and named the worst case exactly:
 *
 *   > `DSV2-04` is the dangerous middle case: `DSV2`→`DSV4` is a *valid*
 *   > forward range, so it would expand to three phantom ids.
 *
 * A backward range (`CPV2-01` → `CPV2`…`CPV1`) is rejected and the row is
 * merely DROPPED. A forward one is ACCEPTED, and that is worse: one requirement
 * becomes three, four or eleven invented ids, last-statement-wins overwrites
 * each expansion with the next, and the tally disagrees with the document while
 * exiting 0. That is the whole failure class this file guards.
 *
 * ── WHAT THE TREE ACTUALLY CONTAINED WHEN THIS WAS WRITTEN ──────────────────
 * Measured, not assumed. The defect was already REPAIRED, by commit `e8f5552b1`
 * ("The tallier read one census row as nine, and read five others as none") on
 * 2026-09-13, which added the `digitPrefixed` branch to `parseIdCell` for
 * census-trust's `TRV2-nn` ids. `DSV2-nn` is the same shape and was fixed with
 * it. census-discovery §12.3 was written the following day and still says the
 * guard defect "is not fixed"; that sentence was stale when it was written.
 *
 * So this file does not repair anything. It does the thing that was missing:
 * it PINS the repair to the three ids the baseline names, and it proves the pin
 * has teeth by running a MUTANT of the parser with the `digitPrefixed` branch
 * deleted and requiring that mutant to fail. A regression test that passes
 * against the broken parser is not a test, and the only way to know which kind
 * this is, is to break the parser and watch.
 *
 * ── THE OTHER HALF: THE RANGES THAT ARE REAL ────────────────────────────────
 * Reading `DSV2-04` as one id is only correct if the ids that genuinely ARE
 * ranges still expand. Four cell shapes below are copied verbatim out of real
 * censuses rather than invented:
 *
 *   `TR58–TR62 + TR64–TR66`        census-trips — a compound that SKIPS TR63,
 *                                  which is scored on its own row
 *   `H147–H149, H152–H154, H160`   census-highlights-memories — a comma list
 *   `MD130–MD138`                  census-media
 *   `L102–L113`                    census-layover
 *
 * ── WHY A FIXTURE ───────────────────────────────────────────────────────────
 * Same reasoning as `censusIdGrammar.test.ts`, whose seam this reuses: the real
 * corpus cannot be made to contain a cell on demand, and pinning a real
 * census's row count would fail every time someone legitimately adds a row.
 * `CENSUS_INTEGRITY_DIR` changes which directory is read and nothing else. CI
 * runs `check:census-integrity` with the seam UNSET against the real tree; this
 * is an additional reach, never the only one.
 *
 * Run: SUPABASE_URL=http://127.0.0.1:9 SUPABASE_SERVICE_ROLE_KEY=dummy \
 *      node --import tsx/esm --test src/test/censusDigitPrefixIds.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../scripts/checkCensusIntegrity.ts", import.meta.url));
const FIXTURE = fileURLToPath(new URL("./fixtures/censusDigitPrefixIds/", import.meta.url));

/**
 * The exact source of the branch this file exists to defend. The mutant is made
 * by DELETING it. If it is ever reformatted, the mutation below stops applying
 * and `mutantSource()` throws rather than quietly producing an unmutated copy —
 * a positive control that silently degrades into a second copy of the happy
 * path is the one outcome worse than having no control at all.
 */
const DIGIT_PREFIXED_BRANCH = `  const digitPrefixed = /^([A-Z]{1,4}[0-9]-[0-9]{1,4})(?![0-9A-Za-z-])/.exec(t);
  if (digitPrefixed) {
    return { ids: [digitPrefixed[1]!], label: t.slice(digitPrefixed[1]!.length).trim() };
  }
`;

/**
 * `census|id|verdict|line` lines the dump prints, for the fixture census only.
 *
 * `--import tsx` rather than `--import tsx/esm`: the mutant below is written to
 * a temp directory outside the package, and the ESM-only loader refuses it with
 * ERR_REQUIRE_CYCLE_MODULE on Node 22. The same loader is used for BOTH runs on
 * purpose — a control that loads the code differently from the thing it is
 * controlling is comparing two variables at once.
 */
function dump(script: string): Array<{ id: string; verdict: string }> {
  const r = spawnSync(process.execPath, ["--import", "tsx", script], {
    encoding: "utf8",
    env: { ...process.env, CENSUS_INTEGRITY_DIR: FIXTURE, CENSUS_INTEGRITY_DUMP: "ALL" },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const rows = out
    .split("\n")
    .filter((l) => l.startsWith("digitprefix|"))
    .map((l) => {
      const f = l.split("|");
      return { id: f[1]!, verdict: f[2]! };
    });
  assert.ok(rows.length > 0, `the fixture census produced no rows at all:\n${out}`);
  return rows;
}

function mutantSource(): string {
  const src = readFileSync(SCRIPT, "utf8");
  const hits = src.split(DIGIT_PREFIXED_BRANCH).length - 1;
  assert.equal(
    hits,
    1,
    "the `digitPrefixed` branch of parseIdCell is no longer present in checkCensusIntegrity.ts in the exact " +
      "form this test mutates. Either the branch was removed — in which case the assertions above should " +
      "already be failing — or it was reformatted, in which case update DIGIT_PREFIXED_BRANCH here. This is " +
      "asserted rather than skipped because a positive control that stops controlling anything is worse than none.",
  );
  return src.replace(DIGIT_PREFIXED_BRANCH, "");
}

describe("parseIdCell: a prefix ending in a digit is an ID, not a RANGE", () => {
  const rows = dump(SCRIPT);
  const ids = rows.map((r) => r.id);
  const verdictOf = (id: string) => rows.find((r) => r.id === id)?.verdict;

  it("reads the three ids reconciled-baseline-v1.md §2.2 names, each as exactly one requirement", () => {
    // These are the three the baseline had to count in prose. The verdicts are
    // the ones they already hold; this pins the PARSE, never the grade.
    assert.equal(verdictOf("DSV2-04"), "N");
    assert.equal(verdictOf("DSV2-05"), "C");
    assert.equal(verdictOf("DSV2-12"), "N");
  });

  it("invents no phantom id from the forward range a DSV2-nn cell would have expanded to", () => {
    // `DSV2-04` as a range is DSV2, DSV3, DSV4; `DSV2-12` is DSV2 … DSV12.
    // None of those is a requirement of anything.
    const phantoms = ids.filter((id) => /^DSV[0-9]{1,2}$/.test(id));
    assert.deepEqual(phantoms, [], `parseIdCell expanded a digit-suffix id into ${phantoms.join(", ")}`);
  });

  it("still expands the cells that are genuinely ranges, copied from four real censuses", () => {
    // census-trips: the compound SKIPS TR63, which is scored on its own row.
    assert.deepEqual(
      ids.filter((i) => i.startsWith("TR")),
      ["TR58", "TR59", "TR60", "TR61", "TR62", "TR64", "TR65", "TR66"],
    );
    assert.equal(ids.includes("TR63"), false, "TR63 is deliberately outside the compound and must not appear");
    // census-highlights-memories: two ranges and a single, comma-joined.
    assert.deepEqual(
      ids.filter((i) => i.startsWith("H")),
      ["H147", "H148", "H149", "H152", "H153", "H154", "H160"],
    );
    // census-media and census-layover: plain ranges.
    assert.equal(ids.filter((i) => i.startsWith("MD")).length, 9);
    assert.equal(ids.filter((i) => i.startsWith("L")).length, 12);
  });

  it("reads the fixture's whole arithmetic: 39 requirements from 8 cells, prose contributing none", () => {
    assert.equal(rows.length, 39);
    assert.equal(rows.filter((r) => r.verdict === "C").length, 17);
    assert.equal(rows.filter((r) => r.verdict === "W").length, 20);
    assert.equal(rows.filter((r) => r.verdict === "N").length, 2);
  });

  // ── POSITIVE CONTROL ──────────────────────────────────────────────────────
  // Everything above would pass unchanged against a parser that never had the
  // fix IF the assertions were the wrong ones, so the fix is removed and the
  // same fixture is read again. This is the only evidence that the assertions
  // are about `digitPrefixed` at all.
  it("POSITIVE CONTROL: with the digitPrefixed branch deleted, the same fixture loses all three ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "census-digitprefix-mutant-"));
    const mutant = join(dir, "checkCensusIntegrity.ts");
    writeFileSync(mutant, mutantSource(), "utf8");

    const mutantRows = dump(mutant);
    const mutantIds = mutantRows.map((r) => r.id);

    // The three ids vanish …
    for (const id of ["DSV2-04", "DSV2-05", "DSV2-12"]) {
      assert.equal(
        mutantIds.includes(id),
        false,
        `${id} survived the mutation, so nothing above is evidence that the digitPrefixed branch is what reads it`,
      );
    }
    // … and are replaced by the phantoms the forward range invents. Eleven of
    // them, because DSV2-12 expands to DSV2 … DSV12 and last-statement-wins
    // collapses the three cells' overlapping expansions onto one another.
    assert.deepEqual(
      mutantIds.filter((i) => /^DSV[0-9]{1,2}$/.test(i)).sort(),
      ["DSV10", "DSV11", "DSV12", "DSV2", "DSV3", "DSV4", "DSV5", "DSV6", "DSV7", "DSV8", "DSV9"],
    );
    // Three requirements became eleven: 39 rows become 47.
    assert.equal(mutantRows.length, 47);
    // And the C is gone — DSV2-05's verdict was overwritten by DSV2-12's N when
    // the expansions collided. A census reporting one fewer correct row than it
    // states, silently, is the failure the whole file is about.
    assert.equal(mutantRows.filter((r) => r.verdict === "C").length, 16);

    // The ranges are UNAFFECTED by the mutation, which is what makes the
    // control specific: it is the digit-suffix rule being removed, not the
    // range grammar being broken.
    assert.equal(mutantIds.filter((i) => i.startsWith("TR")).length, 8);
    assert.equal(mutantIds.filter((i) => i.startsWith("MD")).length, 9);
  });
});
