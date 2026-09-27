/**
 * check:census-scope-coverage counts every citation a census makes, and
 * accepts a per-census NOT-GRADED declaration only where no verdict rests on
 * the file (census-media §32.14).
 *
 * RED WHEN:
 * - an anchored citation whose anchor holds a `.`, `(`, `{`, a space or a
 *   quote goes uncounted;
 * - an Expo route path (`(tabs)`, `[id]`) goes uncounted;
 * - a declaration hides a file a verdict row cites;
 * - a declaration is accepted with no reason, for an uncited file, for a
 *   file that is already watched, or twice.
 *
 * The pure measurement is tested directly. The last case runs the real checker
 * over the real tree, which is the only proof that the censuses meet their
 * floors under the corrected count.
 *
 * Run: node --import tsx/esm --test src/test/censusScopeCoverage.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CITE_RE,
  LEGACY_CITE_RE,
  MIN_REASON,
  isVerdictRowLine,
  measureCensusCoverage,
  resolveAmongCandidates,
  type CoverageInput,
} from "../scripts/lib/censusScopeCoverage.js";

const API_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FILES = new Set([
  "artifacts/api-server/src/routes/posts.ts",
  "artifacts/api-server/src/lib/media/mediaProcessingWorker.ts",
  "travel-buddy-standalone/app/(tabs)/media.tsx",
  "travel-buddy-standalone/app/media-viewer/[id].tsx",
  "artifacts/api-server/src/routes/wall.ts",
  "artifacts/api-server/src/routes/compass.ts",
]);

function input(text: string, scope: string[] = []): CoverageInput {
  return {
    text,
    resolve: (cited) => (FILES.has(cited) ? { path: cited } : null),
    covered: (p) => scope.includes(p),
    isMachinery: () => false,
    isRepoFile: (p) => FILES.has(p),
  };
}

const citedBy = (re: RegExp, text: string) => [...text.matchAll(new RegExp(re.source, "g"))].map((m) => m[1]);

describe("census-media §32.14 — every citation form is counted", () => {
  const ANCHORED = [
    "`artifacts/api-server/src/routes/posts.ts:87#async (req, res, next) => { const auth = await requireUser(req, res); }`",
    "`artifacts/api-server/src/lib/media/mediaProcessingWorker.ts:526#const recorded = await recordMeasuredMediaSize(db, claim, outcome.sizeBytes);`",
    "`artifacts/api-server/src/routes/wall.ts:12#it(\"a quoted 'anchor'\"`",
  ];
  const ROUTES = ["`travel-buddy-standalone/app/(tabs)/media.tsx`", "`travel-buddy-standalone/app/media-viewer/[id].tsx:306#iconSize={28}`"];
  const PLAIN = ["`artifacts/api-server/src/routes/compass.ts`", "`artifacts/api-server/src/routes/compass.ts:12-14`", "`artifacts/api-server/src/routes/compass.ts:12#word`"];

  it("counts an anchored citation whose anchor holds dots, parentheses, braces, spaces or quotes", () => {
    for (const c of ANCHORED) assert.equal(citedBy(CITE_RE, c).length, 1, c);
  });

  it("counts Expo route paths with `(group)` and `[param]` segments", () => {
    for (const c of ROUTES) assert.equal(citedBy(CITE_RE, c).length, 1, c);
  });

  it("still counts the forms the old pattern counted", () => {
    for (const c of PLAIN) assert.equal(citedBy(CITE_RE, c).length, 1, c);
  });

  it("the OLD pattern missed every anchored and every route citation above — the defect, pinned", () => {
    for (const c of [...ANCHORED, ...ROUTES]) assert.equal(citedBy(LEGACY_CITE_RE, c).length, 0, c);
    for (const c of PLAIN) assert.equal(citedBy(LEGACY_CITE_RE, c).length, 1, c);
  });

  it("measureCensusCoverage counts the anchored citation toward the denominator", () => {
    const r = measureCensusCoverage(input(`Prose ${ANCHORED[0]} and ${ROUTES[0]}.`));
    assert.deepEqual(new Set(r.cited), new Set(["artifacts/api-server/src/routes/posts.ts", "travel-buddy-standalone/app/(tabs)/media.tsx"]));
    assert.equal(r.ratio, 0, "neither is watched");
  });
});

describe("census-media §32.14 — a NOT-GRADED declaration says so, and cannot hide a graded file", () => {
  const WALL = "artifacts/api-server/src/routes/wall.ts";
  const POSTS = "artifacts/api-server/src/routes/posts.ts";
  const REASON = "cited for contrast with the Wall's own loader; this census grades no Wall behaviour";

  it("excludes a prose-only file declared with a reason, and reports it", () => {
    const text = [`The Wall does it differently (\`${WALL}:12#x\`).`, "", `- NOT-GRADED: ${WALL} — ${REASON}`].join("\n");
    const r = measureCensusCoverage(input(text));
    assert.deepEqual(r.declarationProblems, []);
    assert.equal(r.declared.get(WALL), REASON);
    assert.deepEqual(r.cited, []);
    assert.equal(r.ratio, 1);
  });

  it("REFUSES a declaration for a file a verdict row cites", () => {
    const text = [
      "| ID | Requirement | Verdict | Evidence |",
      "|---|---|---|---|",
      `| MD999 | something | C | \`${POSTS}:87#async (req, res, next)\` |`,
      "",
      `- NOT-GRADED: ${POSTS} — ${REASON}`,
    ].join("\n");
    const r = measureCensusCoverage(input(text));
    assert.equal(r.declared.size, 0);
    assert.match(r.declarationProblems.join("\n"), /cited on a verdict row/);
    assert.deepEqual(r.uncovered, [POSTS], "still counted, still unwatched");
  });

  it("REFUSES a declaration with no real reason", () => {
    const r = measureCensusCoverage(input([`\`${WALL}\``, `- NOT-GRADED: ${WALL} — contrast`].join("\n")));
    assert.equal(r.declared.size, 0);
    assert.match(r.declarationProblems.join("\n"), new RegExp(`at least ${MIN_REASON}`));
  });

  it("REFUSES a stale declaration: the file is cited nowhere else, and the declaration line is not a citation", () => {
    const r = measureCensusCoverage(input(`- NOT-GRADED: ${WALL} — ${REASON}`));
    assert.match(r.declarationProblems.join("\n"), /not cited anywhere else/);
    assert.equal(r.counts.size, 0, "the declaration line itself counts as no citation");
  });

  it("REFUSES a declaration for a watched file, a non-path, and a duplicate", () => {
    const watched = measureCensusCoverage(input([`\`${WALL}\``, `- NOT-GRADED: ${WALL} — ${REASON}`].join("\n"), [WALL]));
    assert.match(watched.declarationProblems.join("\n"), /already watched/);
    const bare = measureCensusCoverage(input([`\`${WALL}\``, `- NOT-GRADED: wall.ts — ${REASON}`].join("\n")));
    assert.match(bare.declarationProblems.join("\n"), /not an exact repo path/);
    const twice = measureCensusCoverage(input([`\`${WALL}\``, `- NOT-GRADED: ${WALL} — ${REASON}`, `- NOT-GRADED: ${WALL} — ${REASON}`].join("\n")));
    assert.equal(twice.declared.size, 1);
    assert.match(twice.declarationProblems.join("\n"), /declared twice/);
  });

  it("reads verdict rows conservatively: any table line opening with a requirement id", () => {
    for (const l of ["| MD403 | x | W |", "| S112 | x | C |", "| TR38–TR45 | x |", "| TV-2c | x |", "| **L185** | x |", "| G170 | x | C |"]) {
      assert.equal(isVerdictRowLine(l), true, l);
    }
    for (const l of ["| `path.ts` | change | yes |", "| File | Change |", "| --- | --- |", "- MD403 in prose", "| Census | Reported |"]) {
      assert.equal(isVerdictRowLine(l), false, l);
    }
  });
});

describe("census-media §32.14 — which file a citation names: the rule check:doc-citations uses", () => {
  const ROOT_MOCK = "app/messages/[id].tsx";
  const STANDALONE = "travel-buddy-standalone/app/messages/[id].tsx";
  const SNAPSHOT = "files/artifacts/api-server/src/routes/index.ts";
  const REAL = "artifacts/api-server/src/routes/index.ts";
  const LINES: Record<string, string[]> = {
    [ROOT_MOCK]: ["export default function Mock() {", "  return null;", "}"],
    [STANDALONE]: ["import x from 'y';", "export default function ThreadScreen() {", "  const { send } = useMessaging(threadId);"],
    [SNAPSHOT]: ["router.use(tripsRouter);"],
    [REAL]: ["router.use(tripsRouter);"],
  };
  const lineAt = (p: string, n: number) => LINES[p]?.[n - 1];

  it("an ANCHORED citation goes to the one candidate whose cited line holds the anchor — not to the exact root file", () => {
    assert.deepEqual(resolveAmongCandidates(ROOT_MOCK, [ROOT_MOCK, STANDALONE], "3#useMessaging(threadId)", lineAt), { path: STANDALONE });
  });

  it("an anchor that holds nowhere, or in two files, decides nothing: ambiguous, never guessed", () => {
    assert.deepEqual(resolveAmongCandidates(ROOT_MOCK, [ROOT_MOCK, STANDALONE], "3#notThere", lineAt), { ambiguous: true });
    assert.deepEqual(resolveAmongCandidates(REAL, [REAL, SNAPSHOT], "1#router.use(tripsRouter)", lineAt), { ambiguous: true });
  });

  it("an UNANCHORED citation is read literally: the exact path when a file is there, so snapshot copies do not unmeasure a full path", () => {
    assert.deepEqual(resolveAmongCandidates(REAL, [REAL, SNAPSHOT], undefined, lineAt), { path: REAL });
    assert.deepEqual(resolveAmongCandidates(REAL, [REAL, SNAPSHOT], "12-14", lineAt), { path: REAL });
  });

  it("with no exact file and several candidates, an unanchored citation is ambiguous; one candidate is the answer; none is nothing", () => {
    assert.deepEqual(resolveAmongCandidates("routes/index.ts", [REAL, SNAPSHOT], undefined, lineAt), { ambiguous: true });
    assert.deepEqual(resolveAmongCandidates("messages/[id].tsx", [STANDALONE], "9#anything", lineAt), { path: STANDALONE });
    assert.equal(resolveAmongCandidates("nowhere.ts", [], undefined, lineAt), null);
  });

  it("measureCensusCoverage hands the resolver the citation's suffix", () => {
    const seen: Array<[string, string | undefined]> = [];
    measureCensusCoverage({ ...input("`app/messages/[id].tsx:3#useMessaging(threadId)` and `app/x.ts`"), resolve: (c, s) => { seen.push([c, s]); return null; } });
    assert.deepEqual(seen, [["app/messages/[id].tsx", "3#useMessaging(threadId)"], ["app/x.ts", undefined]]);
  });
});

describe("CONTROL — the real checker over the real tree", () => {
  it("passes: every census meets its floor under the corrected count, and every declaration is accepted", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx/esm", "src/scripts/checkCensusScopeCoverage.ts"], { cwd: API_ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`.slice(0, 4000));
    assert.match(r.stdout, /13 censuses measured for scope coverage/, "the check is not passing by measuring nothing");
  });
});
