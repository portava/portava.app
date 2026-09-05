/**
 * docCitations.test.ts — the regression suite for the documentation-accuracy
 * check, and for the four specific defects that produced it.
 *
 * WHAT IS UNDER TEST
 * ==================
 * scripts/check-doc-citations.mjs, driven directly. Nothing here re-implements
 * the checker: every assertion calls the exported function the CLI calls, so a
 * test cannot pass against a copy of the logic that the shipped check does not
 * run.
 *
 * The last two suites are the ones that would have gone red on the defects:
 *
 *   "the real corpus"  — runs the actual checker over the actual COVERED set.
 *                        The stale `check-guard-coverage.mjs:205-213` citation
 *                        is now written anchored, so it fails HERE the next
 *                        time that registry entry moves.
 *
 *   "status vocabulary" — the ROADMAP's own rule allows four labels. A
 *                        comma-qualified label (`DONE, one requirement short`)
 *                        is not one of them, and it is the shape that decays:
 *                        the caveat travels only while someone keeps copying
 *                        it, the word DONE travels on its own.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  COVERED,
  MIN_ANCHORED_CITATIONS,
  anchorHolds,
  evaluateCitations,
  expandLineSpec,
  extractCitations,
  resolveCitationPath,
  resolveCoveredFiles,
} from "../../scripts/check-doc-citations.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// src/test -> artifacts/api-server -> artifacts -> repo root
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");

// ---------------------------------------------------------------------------

describe("expandLineSpec", () => {
  it("returns every range a multi-part spec asserts, and the highest line", () => {
    assert.deepEqual(expandLineSpec("871,991,1004,1013"), {
      max: 1013,
      ranges: [
        [871, 871],
        [991, 991],
        [1004, 1004],
        [1013, 1013],
      ],
    });
  });

  it("normalises a reversed range instead of silently producing an empty one", () => {
    assert.deepEqual(expandLineSpec("216-208"), { max: 216, ranges: [[208, 216]] });
  });
});

// ---------------------------------------------------------------------------

describe("extractCitations", () => {
  it("reads a direct citation and its optional anchor", () => {
    const { citations } = extractCitations(
      "registered with a reason (`scripts/check-guard-coverage.mjs:208-216#reportDiscoveryDivergence`).",
    );
    assert.equal(citations.length, 1);
    assert.equal(citations[0]?.file, "scripts/check-guard-coverage.mjs");
    assert.equal(citations[0]?.spec, "208-216");
    assert.equal(citations[0]?.anchor, "reportDiscoveryDivergence");
    assert.equal(citations[0]?.inherited, false);
  });

  it("leaves anchor undefined — not empty string — on an un-anchored citation", () => {
    const { citations } = extractCitations("see `lib/discoveryShadow.ts:22-27` for the argument");
    assert.equal(citations.length, 1);
    assert.equal(citations[0]?.anchor, undefined);
  });

  it("lets a bare backticked path name the file a following `:NNN` continues", () => {
    // The shape that dominates docs/discovery/ROADMAP.md:
    //   `routes/discovery.ts`: Cache A is checked at `:1786`
    const { citations, orphans } = extractCitations(
      "`routes/discovery.ts`: Cache A is checked at `:1786` and returns first.",
    );
    assert.equal(orphans.length, 0);
    assert.equal(citations.length, 1);
    assert.equal(citations[0]?.file, "routes/discovery.ts");
    assert.equal(citations[0]?.spec, "1786");
    assert.equal(citations[0]?.inherited, true);
  });

  it("does NOT inherit across lines — a bare `:NNN` alone on its line is an orphan", () => {
    // THE FALSE-FAILURE REGRESSION. check-memory-citations.mjs carries
    // `lastFile` across lines, so in docs/discovery/phase-minus-1-repository-proof.md
    // the line "(`skipCache`, `:1222`, `:1262`)" — which means routes/discovery.ts,
    // 3200 lines — inherited lib/discoveryPersistentCache.ts (268 lines) from
    // eighteen lines earlier and reported two failures that were not failures.
    // Guessing a target and inventing one are the same mistake.
    const { citations, orphans } = extractCitations(
      ["cache writes are invalidated (`lib/discoveryPersistentCache.ts:173`).", "", "`sortBy=nearest` bypasses it (`skipCache`, `:1222`, `:1262`)."].join("\n"),
    );
    assert.equal(citations.length, 1, "only the direct citation is evaluable");
    assert.equal(citations[0]?.file, "lib/discoveryPersistentCache.ts");
    assert.deepEqual(
      orphans.map((o) => o.spec),
      ["1222", "1262"],
    );
  });

  it("ignores a colon-number inside a URL", () => {
    const { citations } = extractCitations("see https://example.test/docs/a.md:3 for context");
    assert.equal(citations.length, 0);
  });
});

// ---------------------------------------------------------------------------

describe("anchorHolds — the half a range check cannot do", () => {
  const file = ["zero", "one", "two", "three", "NEEDLE here", "five", "six"];

  it("is true when the needle is on the FIRST line of the cited range", () => {
    assert.equal(anchorHolds(file, [[5, 7]], "NEEDLE"), true);
  });

  it("is FALSE when the needle is inside the range but not on its first line", () => {
    // THE REASON THE RULE IS FIRST-LINE AND NOT CONTAINS-ANYWHERE, and this is
    // the assertion that would have gone red on DEFECT 2.
    //
    // `check-guard-coverage.mjs:205-213` named a nine-line registry entry. The
    // PR inserted three lines above it, moving it to 208-216 — and every token
    // of that entry is STILL somewhere inside the stale 205-213 window, so a
    // contains-anywhere anchor scores the stale citation as correct. Verified
    // against the real file by mutation: the three-line insert left a
    // contains-anywhere check green and the first-line check red.
    assert.equal(anchorHolds(file, [[3, 7]], "NEEDLE"), false);
    assert.equal(anchorHolds(file, [[5, 5]], "NEEDLE"), true);
  });

  it("is FALSE when the code moved out of the cited range entirely", () => {
    assert.equal(anchorHolds(file, [[1, 3]], "NEEDLE"), false);
  });

  it("requires the needle in EVERY part of a multi-part spec", () => {
    // DEFECT 3's shape: four call sites cited as one spec. Three surviving and
    // one moving must fail, or the citation is only three-quarters checked.
    const four = ["a", "hit", "b", "hit", "c", "hit", "d", "moved"];
    assert.equal(anchorHolds(four, [[2, 2], [4, 4], [6, 6]], "hit"), true);
    assert.equal(anchorHolds(four, [[2, 2], [4, 4], [8, 8]], "hit"), false);
  });

  it("is false rather than throwing when the range starts past the end of file", () => {
    assert.equal(anchorHolds(file, [[900, 910]], "NEEDLE"), false);
  });

  it("is false for an empty range list — an unparseable spec proves nothing", () => {
    assert.equal(anchorHolds(file, [], "NEEDLE"), false);
  });
});

// ---------------------------------------------------------------------------

describe("resolveCitationPath", () => {
  const index = new Map<string, string[]>([
    ["places.ts", ["artifacts/api-server/src/routes/places.ts", "travel-buddy-standalone/src/services/places.ts"]],
    ["migrations.md", ["docs/migrations.md"]],
  ]);

  it("narrows by path suffix when the citation carries directories", () => {
    assert.deepEqual(resolveCitationPath("routes/places.ts", index), [
      "artifacts/api-server/src/routes/places.ts",
    ]);
  });

  it("returns every candidate for a bare basename", () => {
    assert.equal(resolveCitationPath("places.ts", index).length, 2);
  });

  it("resolves a doc-relative `../` citation against the citing doc's directory", () => {
    // docs/discovery/ROADMAP.md cites `../migrations.md:327`; without this it
    // was reported as a file that does not exist in the repo.
    assert.deepEqual(resolveCitationPath("../migrations.md", index, "docs/discovery"), [
      "docs/migrations.md",
    ]);
    assert.deepEqual(resolveCitationPath("../migrations.md", index, "docs/architecture"), [
      "docs/migrations.md",
    ]);
  });
});

// ---------------------------------------------------------------------------

describe("evaluateCitations over a synthetic tree", () => {
  const tree: Record<string, string> = {
    "docs/x/GUIDE.md": [
      "range only: `src/thing.ts:3`",
      "anchored and true: `src/thing.ts:2#beta`",
      "anchored and STALE: `src/thing.ts:1#beta`",
      "past the end: `src/thing.ts:99`",
      "no such file: `src/ghost.ts:1`",
    ].join("\n"),
    "src/thing.ts": ["alpha", "beta", "gamma"].join("\n"),
  };
  const byBasename = new Map<string, string[]>([
    ["thing.ts", ["src/thing.ts"]],
    ["GUIDE.md", ["docs/x/GUIDE.md"]],
  ]);
  const readFile = (rel: string): string | null => tree[rel] ?? null;

  const res = evaluateCitations({ coveredFiles: ["docs/x/GUIDE.md"], readFile, byBasename });

  it("counts every citation it saw, and how many carried an anchor", () => {
    assert.equal(res.total, 5);
    assert.equal(res.anchored, 2);
  });

  it("reports the out-of-range and the missing file, and nothing else, as range failures", () => {
    assert.deepEqual(
      res.badRange.map((f) => f.cited).sort(),
      ["src/ghost.ts:1", "src/thing.ts:99"],
    );
  });

  it("reports exactly the anchored citation whose anchor is not at those lines", () => {
    assert.equal(res.badAnchor.length, 1);
    assert.equal(res.badAnchor[0]?.cited, "src/thing.ts:1#beta");
    assert.match(String(res.badAnchor[0]?.reason), /"beta" does not appear at src\/thing\.ts:1/);
  });

  it("does not count a citation whose file is missing as an anchor check", () => {
    // A missing file already failed the range check; charging it a second time
    // would double-count one defect.
    assert.equal(res.badAnchor.some((f) => f.cited.includes("ghost")), false);
  });
});

// ---------------------------------------------------------------------------

describe("the real corpus — every covered citation resolves and every anchor holds", () => {
  const { files, missing } = resolveCoveredFiles(REPO_ROOT, COVERED);

  it("resolves every entry of the COVERED registry to a file on disk", () => {
    assert.deepEqual(missing, []);
    assert.ok(files.length > 0, "COVERED resolved to no files");
  });

  it("passes the real check", () => {
    const byBasename = new Map<string, string[]>();
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isSymbolicLink()) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === ".git" || e.name === "node_modules") continue;
          walk(full);
        } else if (e.isFile()) {
          const rel = path.relative(REPO_ROOT, full);
          const list = byBasename.get(e.name);
          if (list) list.push(rel);
          else byBasename.set(e.name, [rel]);
        }
      }
    };
    walk(REPO_ROOT);

    const readFile = (rel: string): string | null => {
      try {
        return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
      } catch {
        return null;
      }
    };
    const res = evaluateCitations({ coveredFiles: files, readFile, byBasename });

    assert.ok(res.total > 0, "extracted 0 citations — the check would be vacuous");
    assert.deepEqual(
      res.badRange.map((f) => `${f.doc}:${f.line} ${f.cited} — ${String(f.reason)}`),
      [],
    );
    assert.deepEqual(
      res.badAnchor.map((f) => `${f.doc}:${f.line} ${f.cited} — ${String(f.reason)}`),
      [],
    );
    assert.ok(
      res.anchored >= MIN_ANCHORED_CITATIONS,
      `${res.anchored} anchored citations, floor ${MIN_ANCHORED_CITATIONS}`,
    );
  });
});

// ---------------------------------------------------------------------------

describe("status vocabulary — the ROADMAP's own four labels", () => {
  const roadmap = fs.readFileSync(path.join(REPO_ROOT, "docs/discovery/ROADMAP.md"), "utf8");

  it("states the rule it is being held to", () => {
    // If the rule is ever reworded, this test must be re-derived from the new
    // wording rather than left asserting a rule the document no longer makes.
    assert.match(roadmap, /Use `DONE`, `IN PROGRESS`,\s*\n?> `BLOCKED — <reason>`, or `NOT STARTED`\./);
  });

  it("carries no comma-qualified status label", () => {
    // `**DONE, one requirement short**` was the shape. An em-dash elaboration
    // (`**DONE — measured, not estimated.**`) is fine: it expands a verdict it
    // does not retract. A comma-qualified label retracts part of the verdict
    // inside the label itself, so the caveat can be dropped by anyone who
    // copies just the word.
    const offenders: string[] = [];
    const bold = /\*\*([^*\n]{1,160})\*\*/g;
    let m: RegExpExecArray | null;
    while ((m = bold.exec(roadmap)) !== null) {
      const label = (m[1] ?? "").trim();
      if (/^(DONE|IN PROGRESS|NOT STARTED|BLOCKED)\s*,/.test(label)) offenders.push(label);
    }
    assert.deepEqual(offenders, []);
  });

  it("labels Phase C's C3 unit IN PROGRESS with its met-requirement count", () => {
    // The positive half: the relabel is asserted, not merely the absence of the
    // old string, so deleting the row would not make this suite green.
    assert.match(roadmap, /\*\*C3 IN PROGRESS\*\*/);
    assert.match(roadmap, /\*\*C3\*\* — the divergence report \| \*\*IN PROGRESS\*\* \(5 of 6 requirements\)/);
  });
});
