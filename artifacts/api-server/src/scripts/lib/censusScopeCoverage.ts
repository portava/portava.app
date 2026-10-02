/**
 * What a census CITES, measured the same way for every census, and what it
 * DECLARES it cites without grading.
 *
 * WHY THIS IS ITS OWN FILE
 * ========================
 * `checkCensusScopeCoverage.ts` runs on import against the real tree, so the
 * two things it could get wrong could not be tested in isolation:
 * - which citations it counts;
 * - which exclusions it accepts.
 * Both are here as pure functions. The checker is a thin loop over them.
 *
 * THE DEFECT THIS FIXES (census-media §32.14, measured 2026-09-27)
 * ================================================================
 * The checker's pattern was:
 *
 *     /`([A-Za-z0-9_./-]+\.(?:ts|tsx|sql|mjs|js|json|yml))(?::[0-9,\-#A-Za-z_]*)?`/g
 *
 * It counted a citation only when everything after the colon was digits,
 * commas, dashes, `#`, letters or underscores, and only when the path had no
 * `(` or `[`. So:
 * - An anchored citation — `path:LINE#text`, the form check:doc-citations
 *   verifies — was not counted whenever its anchor text held a `.`, `(`, `{`,
 *   a space or a quote. That is most of them.
 * - Expo route files (`app/(tabs)/media.tsx`, `app/media-viewer/[id].tsx`) were
 *   never counted at all.
 *
 * Counting every citation took 12 of the 13 censuses below their floors, and
 * census-media from a reported 96 % to 85 %. The reported ratios had been
 * measured over the citations the pattern happened to match, not over the
 * citations the census makes.
 *
 * "SAY SO", MADE CONCRETE AND BOUNDED
 * ===================================
 * The checker's failure message has always offered two remedies:
 * - watch the file;
 * - or, if the census genuinely does not grade it, say so.
 * `NOT_GRADED` in the checker says so for shared machinery, globally. This
 * module adds a per-census form, written in the census itself, at its tail:
 *
 *     - NOT-GRADED: path/from/repo/root.ts — the reason, in a sentence
 *
 * The line carries no backticks, so it is not itself a citation, and
 * check:doc-citations does not read it as one.
 *
 * A declaration is refused unless every one of these holds:
 * - the path is an exact repo path;
 * - the census cites the file somewhere other than the declaration;
 * - the reason is at least MIN_REASON characters;
 * - the file is not already watched, and is not machinery;
 * - the file is not declared twice;
 * - NO VERDICT ROW CITES IT.
 *
 * The last rule is what stops this from hiding a gap. A row whose evidence
 * names a file rests on that file, so the file is graded and must be watched.
 * "Verdict row" is read conservatively: any table line whose first cell opens
 * with a requirement id. That refuses more declarations than the census-
 * integrity parser would, never fewer.
 *
 * WHAT WOULD MAKE THIS WRONG (P24): a census that grades a file only in prose
 * — a section that moves a row and names the file as its evidence while the
 * row cell says "see §N" — can still declare that file not graded. The written
 * reason is the defence, and it is reviewable in the census, next to the prose
 * that would contradict it.
 */

/** A file citation, with or without a `:LINE`, `:A-B` or `:LINE#anchor` suffix (group 2). */
export const CITE_RE = /`([A-Za-z0-9_./()\[\]+@-]+\.(?:ts|tsx|sql|mjs|js|json|yml))(?::([^`\n]*))?`/g;

/** The pattern this module replaced, kept so the tests can show what it missed. */
export const LEGACY_CITE_RE = /`([A-Za-z0-9_./-]+\.(?:ts|tsx|sql|mjs|js|json|yml))(?::[0-9,\-#A-Za-z_]*)?`/g;

/** `- NOT-GRADED: path — reason` (an em dash). */
export const NOT_GRADED_DECL_RE = /^- NOT-GRADED: (\S+) — (.+)$/;

/** A reason must say something. Twenty-five characters is one short clause. */
export const MIN_REASON = 25;

/**
 * A table line whose first cell opens with a requirement id: `| MD403 |`,
 * `| S112 |`, `| TR38–TR45 |`, `| TV-2c |`, `| **L185** |`. Read
 * conservatively, so it may match a non-verdict table whose first column is an
 * id. That can only refuse a declaration, never admit one.
 */
export function isVerdictRowLine(line: string): boolean {
  if (!line.startsWith("|")) return false;
  const first = line.split("|")[1] ?? "";
  return /^\s*\*{0,2}[A-Z][A-Za-z]{0,5}[-‑]?[0-9]/.test(first);
}

export type Resolution = { path: string } | { ambiguous: true } | null;

/**
 * WHICH FILE A CITATION NAMES — the rule check:doc-citations uses
 * (`resolveCitationPath` + its anchor test), so the two guards cannot disagree
 * about it. Measured 2026-09-27: this checker took an exact root path whenever
 * one existed, so `app/messages/[id].tsx` — cited 40 times by census-telegraph,
 * meaning the standalone client's screen — resolved to a 44-line mock at the
 * repo root, while doc-citations verified the same citations against the
 * standalone file. `candidates` is every repo path equal to the citation or
 * ending in `/` + it. One candidate is the answer. Several are decided:
 *
 * - AN ANCHORED citation (`:LINE#text`) by its anchor, exactly as doc-citations
 *   decides it: the candidates whose cited line contains the anchor text.
 *   Exactly one is the answer; none or several is AMBIGUOUS — reported, never
 *   guessed. (doc-citations fails the "several" case outright, so a census that
 *   passes it never reaches that branch.)
 * - AN UNANCHORED citation literally: the path exactly as written, if a file is
 *   there. The repo carries legacy snapshot trees (`files/`, `follows-backend/`,
 *   `portava-stamp-wave2-files/`, …) holding copies of real paths, so every
 *   full path `artifacts/api-server/src/routes/index.ts` also suffix-matches
 *   `files/artifacts/api-server/src/routes/index.ts`; reading those as
 *   ambiguous would stop the checker measuring the plainest citations there
 *   are. With no exact file, several candidates are ambiguous.
 */
export function resolveAmongCandidates(
  cited: string,
  candidates: readonly string[],
  suffix: string | undefined,
  lineAt: (path: string, line: number) => string | undefined,
): Resolution {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { path: candidates[0]! };
  const m = /^(\d+)(?:[-–,]\d+)*#(.+)$/.exec(suffix ?? "");
  if (!m) return candidates.includes(cited) ? { path: cited } : { ambiguous: true };
  const line = Number(m[1]);
  const needle = m[2]!;
  const holding = candidates.filter((c) => (lineAt(c, line) ?? "").includes(needle));
  return holding.length === 1 ? { path: holding[0]! } : { ambiguous: true };
}

export interface CoverageInput {
  /** The census document. */
  text: string;
  /** A cited path plus its `:…` suffix (if any) to one repo path, to ambiguity, or to nothing. */
  resolve: (cited: string, suffix?: string) => Resolution;
  /** Is this repo path in the census's CENSUS_SCOPE? */
  covered: (path: string) => boolean;
  /** Is this repo path shared machinery (the checker's NOT_GRADED)? */
  isMachinery: (path: string) => boolean;
  /** Does this exact repo path exist as a file? */
  isRepoFile: (path: string) => boolean;
}

export interface CoverageResult {
  /** Resolved path → number of citations. */
  counts: Map<string, number>;
  ambiguous: number;
  unresolved: number;
  machinery: string[];
  /** Accepted declarations: path → reason. */
  declared: Map<string, string>;
  /** The denominator: cited, not machinery, not declared. */
  cited: string[];
  /** Denominator paths not in scope, most-cited first. */
  uncovered: string[];
  ratio: number;
  /** Why a declaration was refused, one line each. */
  declarationProblems: string[];
}

export function measureCensusCoverage(input: CoverageInput): CoverageResult {
  const lines = input.text.split("\n");
  const counts = new Map<string, number>();
  const rowCited = new Set<string>();
  let ambiguous = 0;
  let unresolved = 0;
  const declLines: Array<{ path: string; reason: string; line: number }> = [];

  lines.forEach((line, i) => {
    const decl = NOT_GRADED_DECL_RE.exec(line);
    if (decl) { declLines.push({ path: decl[1]!, reason: decl[2]!.trim(), line: i + 1 }); return; }
    const row = isVerdictRowLine(line);
    for (const m of line.matchAll(CITE_RE)) {
      const r = input.resolve(m[1]!, m[2]);
      if (r === null) { unresolved++; continue; }
      if ("ambiguous" in r) { ambiguous++; continue; }
      counts.set(r.path, (counts.get(r.path) ?? 0) + 1);
      if (row) rowCited.add(r.path);
    }
  });

  const declared = new Map<string, string>();
  const declarationProblems: string[] = [];
  for (const d of declLines) {
    const at = `line ${d.line}: NOT-GRADED ${d.path}`;
    if (declared.has(d.path)) { declarationProblems.push(`${at} is declared twice.`); continue; }
    if (!input.isRepoFile(d.path)) { declarationProblems.push(`${at} is not an exact repo path to a file. Write the full path from the repo root.`); continue; }
    if (!counts.has(d.path)) { declarationProblems.push(`${at} is not cited anywhere else in this census. A stale declaration hides nothing today and would hide the next citation; delete it.`); continue; }
    if (d.reason.length < MIN_REASON) { declarationProblems.push(`${at} gives no reason (${d.reason.length} characters; at least ${MIN_REASON}). Say why this census cites the file without grading it.`); continue; }
    if (input.isMachinery(d.path)) { declarationProblems.push(`${at} is shared machinery and already excluded; the declaration is redundant.`); continue; }
    if (input.covered(d.path)) { declarationProblems.push(`${at} is already watched by CENSUS_SCOPE; the declaration is redundant.`); continue; }
    if (rowCited.has(d.path)) { declarationProblems.push(`${at} is cited on a verdict row, so a verdict rests on it and it is graded. Watch it (add it to CENSUS_SCOPE); it cannot be declared not graded.`); continue; }
    declared.set(d.path, d.reason);
  }

  const all = [...counts.keys()];
  const machinery = all.filter((p) => input.isMachinery(p));
  const cited = all.filter((p) => !input.isMachinery(p) && !declared.has(p));
  const uncovered = cited.filter((p) => !input.covered(p)).sort((a, b) => counts.get(b)! - counts.get(a)!);
  const ratio = cited.length === 0 ? 1 : (cited.length - uncovered.length) / cited.length;
  return { counts, ambiguous, unresolved, machinery, declared, cited, uncovered, ratio, declarationProblems };
}
