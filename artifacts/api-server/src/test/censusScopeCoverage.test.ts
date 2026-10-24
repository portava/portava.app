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

// ── census-telegraph P.7 (2026-10-24): an APPEND-ONLY census withdraws a NOT-GRADED declaration ───────────
// A census may not edit an earlier section, so a file that later comes to carry a verdict cannot have its
// old NOT-GRADED line rewritten. A LATER `- WITHDRAWN NOT-GRADED: path — reason` line retires it instead.
//   MUTANT SW1 withdrawals ignored (the old declaration is judged as before) ........ red
describe("census-telegraph P.7 — an appended withdrawal retires an earlier NOT-GRADED declaration", () => {
  const POSTS = "artifacts/api-server/src/routes/posts.ts";
  const REASON = "cited as EVIDENCE for a section's claim, not a graded surface in this census";
  const WHY = "a later section cites it on a verdict row, so a verdict now rests on it and it is watched";
  const ROW = `| T999 | W | **C** | \`${POSTS}:87#async (req, res, next)\` |`;

  it("the withdrawn declaration is neither a declaration nor a problem; the file is graded and counted", () => {
    const text = [`- NOT-GRADED: ${POSTS} — ${REASON}`, "", ROW, "", `- WITHDRAWN NOT-GRADED: ${POSTS} — ${WHY}`].join("\n");
    const r = measureCensusCoverage(input(text, [POSTS]));
    assert.deepEqual(r.declarationProblems, []);
    assert.equal(r.declared.size, 0);
    assert.deepEqual(r.cited, [POSTS]);
    assert.equal(r.ratio, 1);
  });

  it("without the withdrawal the same text is refused, as before", () => {
    const r = measureCensusCoverage(input([`- NOT-GRADED: ${POSTS} — ${REASON}`, "", ROW].join("\n"), [POSTS]));
    assert.match(r.declarationProblems.join("\n"), /already watched|cited on a verdict row/);
  });

  it("REFUSES a withdrawal of nothing, one placed BEFORE the declaration, and one with no reason", () => {
    const none = measureCensusCoverage(input([ROW, `- WITHDRAWN NOT-GRADED: ${POSTS} — ${WHY}`].join("\n"), [POSTS]));
    assert.match(none.declarationProblems.join("\n"), /withdraws no EARLIER declaration/);
    const before = measureCensusCoverage(input([`- WITHDRAWN NOT-GRADED: ${POSTS} — ${WHY}`, `- NOT-GRADED: ${POSTS} — ${REASON}`, ROW].join("\n"), [POSTS]));
    assert.match(before.declarationProblems.join("\n"), /withdraws no EARLIER declaration/);
    assert.match(before.declarationProblems.join("\n"), /already watched|cited on a verdict row/, "the declaration still stands, so it is still judged");
    const bare = measureCensusCoverage(input([`- NOT-GRADED: ${POSTS} — ${REASON}`, ROW, `- WITHDRAWN NOT-GRADED: ${POSTS} — stale`].join("\n"), [POSTS]));
    assert.match(bare.declarationProblems.join("\n"), new RegExp(`at least ${MIN_REASON}`));
  });

  it("the withdrawal line itself is not a citation", () => {
    const r = measureCensusCoverage(input([`- NOT-GRADED: ${POSTS} — ${REASON}`, `\`${POSTS}\``, `- WITHDRAWN NOT-GRADED: \`${POSTS}\` — ${WHY}`].join("\n"), [POSTS]));
    assert.equal(r.counts.get(POSTS), 1);
  });
});
