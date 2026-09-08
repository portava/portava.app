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

describe("Expo dynamic-route paths — `app/messages/[id].tsx`", () => {
  /**
   * WHY THE GRAMMAR HAS SQUARE BRACKETS IN IT.
   *
   * The client is an Expo Router app, so its route files are literally named
   * `[id].tsx`, `[slug].tsx`, `[handle].tsx`. The path segment class excluded
   * `[` and `]`, which made those citations INVISIBLE — and invisible is worse
   * than unchecked here, because the line-local inheritance rule then resolves a
   * following bare `:NNN` against whatever file WAS visible.
   *
   * Measured on the real corpus: census-telegraph.md:780 cites
   * `app/messages/[id].tsx:1247-1252` and `:1260-1266` side by side. The first
   * was not extracted at all; the second inherited `src/services/messaging.ts`
   * (767 lines) from earlier on the line and was reported as out of range. The
   * citation was right and the grammar was wrong — a false failure and a missed
   * one from a single omission. 62 lines across docs/architecture/ carry a
   * bracketed path.
   */
  it("extracts a bracketed route path as its own citation", () => {
    const { citations } = extractCitations("see `app/messages/[id].tsx:1247-1252`");
    assert.equal(citations.length, 1);
    assert.equal(citations[0]?.file, "app/messages/[id].tsx");
    assert.equal(citations[0]?.spec, "1247-1252");
  });

  it("a following bare :NNN inherits the BRACKETED file, not the one before it", () => {
    // This is the whole point. Without brackets in the grammar the second spec
    // silently belongs to messaging.ts.
    const { citations } = extractCitations(
      "`src/services/messaging.ts:238`, then `app/messages/[id].tsx:1247-1252` and `:1260-1266`",
    );
    assert.deepEqual(
      citations.map((c) => `${c.file}:${c.spec}`),
      ["src/services/messaging.ts:238", "app/messages/[id].tsx:1247-1252", "app/messages/[id].tsx:1260-1266"],
    );
  });

  it("resolves a bracketed path by its real basename", () => {
    const byBasename = new Map<string, string[]>([
      ["[id].tsx", ["travel-buddy-standalone/app/messages/[id].tsx"]],
    ]);
    assert.deepEqual(
      resolveCitationPath("app/messages/[id].tsx", byBasename),
      ["travel-buddy-standalone/app/messages/[id].tsx"],
    );
  });

  it("does not swallow a markdown link into the path", () => {
    // `[text](path.ts:12)` must not extract `[text](path.ts` — the closing
    // paren and the opening one are outside the segment class, so the path can
    // only be what follows `(`.
    const { citations } = extractCitations("[the runner](scripts/run.ts:12) does it");
    assert.deepEqual(citations.map((c) => c.file), ["scripts/run.ts"]);
  });
});

// ---------------------------------------------------------------------------

describe("an anchored citation that goes OUT OF RANGE is still an anchored citation", () => {
  /**
   * THE DEFECT THIS PINS, AND HOW IT WAS FOUND.
   *
   * `anchored` used to be incremented AFTER the range checks, so a citation
   * whose file had shrunk past the cited line bailed out before ever being
   * counted. MIN_ANCHORED_CITATIONS sits AT the measured count by the
   * SHRINK-ONLY rule, so one moved file dropped the count below the floor and
   * the checker exited 2 with "restore the anchors, or lower the floor" — about
   * a citation whose anchor nobody had touched. The failure was real; the
   * diagnosis pointed at the wrong thing, and at an exit code that means "this
   * checker could not run honestly" rather than "your citation is stale".
   *
   * Found by mutation, not by reading: changing a live citation in
   * wall-certification.md from `WallDiversityService.ts:218#applyFeedDiversity`
   * to `:263` in a 254-line file produced exit 2 and that message. With the
   * count taken first, the same mutation now produces exit 1 and names the
   * range failure. The floor asks how many claims in the corpus are ANCHORED,
   * which is a property of the text; whether an anchor currently HOLDS is what
   * badAnchor is for.
   */
  const tree: Record<string, string> = {
    "docs/x/GUIDE.md": [
      "anchored and true: `src/thing.ts:2#beta`",
      "anchored, file has shrunk past it: `src/thing.ts:99#beta`",
      "anchored, file gone entirely: `src/ghost.ts:1#beta`",
      "not anchored, also past the end: `src/thing.ts:98`",
    ].join("\n"),
    "src/thing.ts": ["alpha", "beta", "gamma"].join("\n"),
  };
  const byBasename = new Map<string, string[]>([
    ["thing.ts", ["src/thing.ts"]],
    ["GUIDE.md", ["docs/x/GUIDE.md"]],
  ]);
  const readFile = (rel: string): string | null => tree[rel] ?? null;
  const res = evaluateCitations({ coveredFiles: ["docs/x/GUIDE.md"], readFile, byBasename });

  it("counts all three anchored citations, including the two that cannot resolve", () => {
    assert.equal(res.total, 4);
    assert.equal(res.anchored, 3);
  });

  it("reports both unresolvable citations as RANGE failures", () => {
    assert.deepEqual(
      res.badRange.map((f) => f.cited).sort(),
      ["src/ghost.ts:1#beta", "src/thing.ts:98", "src/thing.ts:99#beta"],
    );
  });

  it("charges neither of them a second time as a broken anchor", () => {
    // One defect, one finding. A citation pointing past the end of its file is
    // stale for one reason, and reporting it twice would inflate the count the
    // CLI prints and make the fix look bigger than it is.
    assert.deepEqual(res.badAnchor, []);
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
