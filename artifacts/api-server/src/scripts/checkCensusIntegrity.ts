/**
 * checkCensusIntegrity — does each census agree with itself?
 *
 * The thirteen documents in docs/architecture/census-*.md are the only
 * per-architecture measurement this repository has. Each states a headline —
 * "CONSTRUCTED 36.1 % / CORRECT 6.8 %" — above a table that assigns one verdict
 * to each requirement. The headline is supposed to be that table, counted.
 *
 * THREE OF THE THIRTEEN ALREADY CARRY A CORRECTION HEADER SAYING IT WAS NOT.
 * census-layover.md, census-map.md and census-sensing.md each open with a block
 * added after the fact, saying the body's headline is stale or wrong and that a
 * later pass re-derived it. In two of those the corrected figure moved by more
 * than a rounding error. A number nobody can recompute is a number that drifts
 * quietly, and these are the numbers a reader uses to decide where to spend a
 * month.
 *
 * So this check recomputes what CAN be recomputed and refuses to invent the
 * rest.
 *
 * ── A PR-COMPARISON TABLE IS NOT A RECOUNT ───────────────────────────────────
 * This tool takes the LAST verdict on a row, which is right for a recount
 * section restating a row a later pass revised. census-layover.md §5 is headed
 * `| id | Requirement | Main | With #463 | What changes |` and compares the
 * tree against an UNMERGED pull request. Every row there holds two verdicts,
 * and last-wins took the PR's. Four requirements (L34, L47, L48, L230) were
 * recorded C/W when main has N, W, N, N: the tool reported unmerged work as
 * shipped, inside the one document whose purpose is to say what is built.
 *
 * Rows in a table whose header names a PR or reads as a hypothetical are now
 * SKIPPED — they are not statements about HEAD in either direction.
 *
 * MEASURED, on a synthetic census with such a table and no correcting rows:
 *
 *   without the skip   C=2  W=0  N=1     <- two requirements reported CORRECT
 *   with the skip      C=0  W=0  N=3        that are not built at all
 *
 * The synthetic case is needed because on census-layover.md itself the bug is
 * currently MASKED: a later pass added correcting rows in §9.5, and those come
 * after §5, so last-wins already overrides the PR verdicts there. Removing the
 * skip changes nothing on the real corpus today. That makes the fix invisible
 * to a mutation test against the repository — and a fix that is only invisible
 * because somebody else worked around the bug by hand is exactly the kind that
 * gets deleted later as unnecessary.
 *
 * ── WHAT IT CHECKS ───────────────────────────────────────────────────────────
 * 1. DUPLICATE IDS. Two rows claiming the same requirement id means one of them
 *    is uncounted or double-counted, and no reader would see it. Hard failure.
 * 2. VACUITY. A census file with no parseable verdict rows at all is not a
 *    clean census, it is an unreadable one. Hard failure.
 * 3. OVERCOUNT. Parsed rows exceeding EVERY stated denominator is
 *    arithmetically impossible and means one of the two is wrong. Hard failure.
 *
 * ── A ROW WITH AN ID AND NO VERDICT IS COUNTED, NOT CONDEMNED ────────────────
 * An earlier draft of this header promised that such a row was a hard failure,
 * "because a row with no verdict silently leaves every total". Writing it that
 * way was wrong and a mutation test caught it: census-wall.md keys eight rows
 * by requirement id in tables that are NOT verdict tables (a cross-reference
 * listing `| W71 | 17 |`), and failing those would be an accusation aimed at a
 * document doing nothing wrong. So they are counted and PRINTED per census
 * instead. The number is the honest form of the concern: where it is large,
 * fewer of that census's rows are machine-checked than the row count suggests.
 *
 * That is also why this file no longer claims the check it does not perform.
 * The claim outlived the code by one commit, which is the same defect this
 * repository keeps finding in its own guards.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CHECK, AND WHY ─────────────────────────────
 * It DOES require them to be equal in the one case where the exemption below
 * cannot apply: when the parsed row count equals the stated denominator, every
 * requirement was parsed, there is no prose gap, and a headline that does not
 * sum to the denominator is arithmetic rather than judgement. That rule was
 * added on 2026-09-08 after census-layover was found stating 27 + 133 + 139
 * against a denominator of 296.
 *
 * Otherwise it does NOT require the parsed counts to equal the stated headline, because
 * for several censuses that would be a false accusation. Some requirements are
 * counted in PROSE rather than in a table row — census-highlights-memories.md
 * §17 says "eleven of the seventeen operations ... each is BBW" in a paragraph
 * and lists them inline, which is a legitimate way to count eleven requirements
 * and an impossible one to parse. So the reconciliation gap is REPORTED as a
 * number per census ("N requirements are counted somewhere this tool cannot
 * read") rather than treated as an error. A tool that cried wolf on prose
 * counting would be turned off, and then the duplicate-id check would go with
 * it.
 *
 * The gap is printed precisely so it is visible how much of each headline rests
 * on something machine-checkable. Where the gap is large, the headline is
 * mostly an assertion.
 *
 * Run: node --import tsx/esm src/scripts/checkCensusIntegrity.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CENSUS_DIR = new URL("../../../../docs/architecture/", import.meta.url).pathname;

/** A tree with no censuses is a tree this check could not find. */
const MIN_CENSUS_FILES = 10;
const MIN_ROWS_PER_CENSUS = 1;

type Verdict = "C" | "W" | "N" | "X";

interface Row { id: string; verdict: Verdict; line: number }

interface CensusResult {
  file: string;
  /** One entry per requirement id, carrying its CURRENT (last-stated) verdict. */
  rows: Row[];
  /** Ids restated by a later recount section — a revision, not a duplicate. */
  revised: string[];
  /** Rows keyed by an id that carry no verdict at all (summary/cross-reference tables). */
  nonVerdictRows: number;
  /** Rows in a PR-comparison or hypothetical table — NOT statements about HEAD. */
  hypotheticalRows: number;
  counts: Record<Verdict, number>;
  statedDenominator: number | null;
  /**
   * The LAST headline the document states, as a bucket count — the one a reader
   * who scrolls to the newest section would quote. Null when no headline table
   * states all four buckets.
   */
  statedHeadline: { c: number; w: number; n: number; x: number } | null;
  /** Every denominator the document states. More than one is deliberate, not a bug. */
  allDenominators: number[];
  duplicates: Array<{ id: string; lines: number[] }>;
  hasCorrectionHeader: boolean;
}

/**
 * THE CENSUSES DO NOT SHARE A VOCABULARY, and assuming they did is how the
 * first version of this file reported three of them as having zero rows.
 * census-layover / map / telegraph / trips / media / passport / wall / discovery
 * write C / W / N / X. census-highlights-memories writes BAC / BBW / NB / CV.
 * census-sensing writes BC / BW / NB / CV. They mean the same four buckets, so
 * they are normalised here rather than each being called unreadable.
 */
const VERDICT_ALIASES: Record<string, Verdict> = {
  C: "C", BAC: "C", BC: "C",
  W: "W", BBW: "W", BW: "W",
  N: "N", NB: "N",
  X: "X", CV: "X",
};

/** `**C**` / ` BAC ` / `**BW**` → the bucket, or null if the cell is not a verdict. */
function verdictOf(cell: string): Verdict | null {
  const t = cell.trim().replace(/\*/g, "").toUpperCase();
  return VERDICT_ALIASES[t] ?? null;
}

/**
 * A requirement id. The hyphen is not decoration: census-compass numbers its
 * rows CX-03, and a pattern without it silently parsed that whole census as
 * empty — the exact vacuity this file is supposed to catch, committed by the
 * file itself on its first run.
 */
const ID_CELL = /^\*{0,2}([A-Z]{1,4}-?[0-9]{1,4}[a-z]?)\*{0,2}$/;

function parseCensus(file: string, text: string): CensusResult {
  const seenRows: Row[] = [];
  let nonVerdictRows = 0;
  let hypotheticalRows = 0;
  const lines = text.split("\n");

  // Track which TABLE each row belongs to, by remembering the last header row
  // (a `|...|` line immediately followed by a `|---|` separator).
  //
  // This exists because of a measured false green. census-layover.md §5 carries
  // a table headed `| id | Requirement | Main | With #463 | What changes |`,
  // comparing the tree against an UNMERGED pull request. Every one of its rows
  // holds two verdicts, and the last-statement-wins rule -- correct for a
  // recount table, which restates a row a later pass revised -- took the PR's
  // hypothetical verdict as current. Four requirements (L34, L47, L48, L230)
  // were recorded as C/W when main has N, W, N, N. The tool was reporting
  // unmerged work as shipped, in a document whose whole purpose is to say what
  // is actually built.
  //
  // A hypothetical table is not a recount and its rows are not statements about
  // HEAD, so they are skipped entirely rather than read in either direction.
  let headerCells: string[] = [];
  const isSeparator = (l: string) => /^\|[\s:|-]+\|?$/.test(l.trim()) && l.includes("-");
  /** A column header naming a PR, or phrased as a hypothetical. */
  const HYPOTHETICAL = /#\d+|\bwould\b|\bif applied\b|\bhypothetical\b|\bproposed\b/i;

  lines.forEach((line, i) => {
    if (!line.startsWith("|")) { headerCells = []; return; }
    if (isSeparator(line)) return;
    const cells = line.split("|").slice(1, -1);
    if (cells.length < 3) return;
    // Is this line a header? It is if the NEXT line is a separator.
    if (isSeparator(lines[i + 1] ?? "")) { headerCells = cells.map((c) => c.trim()); return; }
    const idm = ID_CELL.exec(cells[0]!.trim());
    if (!idm) return;
    const id = idm[1]!;
    // The verdict is whichever cell holds a bare verdict token. Censuses differ
    // in column count (some carry an extra "spec section" column), so the
    // position is FOUND rather than assumed — assuming column 4 would silently
    // drop every row in a census laid out differently, which is the same
    // vacuity this file exists to catch.
    // Take the LAST bare verdict cell, not the first. A requirement row reads
    // `| id | description | verdict | evidence |` and has exactly one. A RECOUNT
    // row — census-layover §7 and §8 restate rows a later pass revised — reads
    // `| id | old | new | reason |` and has TWO, of which the first is the
    // verdict being superseded. Taking the first recorded the OLD verdict as
    // current for 31 layover rows, which would have reported the pre-pass state
    // as the present one.
    const found: Verdict[] = [];
    for (let c = 1; c < cells.length; c++) {
      const got = verdictOf(cells[c]!);
      if (got) found.push(got);
    }
    // Two or more verdicts in a table whose header names a PR or reads as a
    // hypothetical is a COMPARISON, not a revision. Skip it.
    if (found.length > 1 && headerCells.some((h) => HYPOTHETICAL.test(h))) {
      hypotheticalRows++;
      return;
    }
    if (found.length > 0) seenRows.push({ id, verdict: found[found.length - 1]!, line: i + 1 });
    else nonVerdictRows++;
  });

  // LAST STATEMENT WINS. A census that revises a verdict does it by restating
  // the row in a later recount section, so the current verdict is the last one
  // written. Counting every occurrence double-counts the revised rows and
  // reports the superseded verdict alongside its replacement.
  const current = new Map<string, Row>();
  const occurrences = new Map<string, number>();
  for (const r of seenRows) {
    current.set(r.id, r);
    occurrences.set(r.id, (occurrences.get(r.id) ?? 0) + 1);
  }
  const rows = [...current.values()];
  const revised = [...occurrences.entries()].filter(([, n]) => n > 1).map(([id]) => id).sort();

  const counts: Record<Verdict, number> = { C: 0, W: 0, N: 0, X: 0 };
  for (const r of rows) counts[r.verdict]++;

  const duplicates: CensusResult["duplicates"] = [];

  // "Denominator (testable requirements) | **266** |" and its variants.
  //
  // A census may state MORE THAN ONE denominator, and census-compass does: it
  // scores against 70 (inbound requirements only) and against 90 (all three
  // sources), presenting both columns deliberately. Taking the first match gave
  // 70 and then reported 78 parsed rows as "more rows than requirements is
  // arithmetically impossible" — an accusation aimed at a document that was
  // being more careful than the tool. So every candidate is collected, the
  // overcount test uses the LARGEST (the only one it can be violated against),
  // and a census stating several is flagged as ambiguous rather than wrong.
  const candidates: number[] = [];
  for (const m of text.matchAll(/\|\s*\*{0,2}Denominator[^|]*\|\s*\*{0,2}([0-9]{1,4})\*{0,2}\s*\|/gi)) candidates.push(Number(m[1]));
  for (const m of text.matchAll(/how ([0-9]{2,4}) was counted/gi)) candidates.push(Number(m[1]));
  for (const m of text.matchAll(/\/\s*([0-9]{2,4})\s*=\s*\*{0,2}[0-9.]+\s*%/g)) candidates.push(Number(m[1]));
  const uniqueDenoms = [...new Set(candidates)].sort((a, b) => a - b);
  const statedDenominator = uniqueDenoms.length > 0 ? uniqueDenoms[uniqueDenoms.length - 1]! : null;

  // The stated headline, as four bucket counts. Censuses write it as a small
  // table of `| BUILT-AND-CORRECT | ... | **30** |` rows, sometimes with a
  // "was / now" pair, so the LAST number on each line is the current claim and
  // the LAST such block in the file is the current headline. A block that does
  // not state all four buckets is not a headline and is ignored — this must not
  // half-read a table and then accuse it of not summing.
  const headlineFor = (label: RegExp): number[] => {
    const found: number[] = [];
    for (const m of text.matchAll(new RegExp(`^>?\\s*\\|\\s*${label.source}[^|]*((?:\\|[^|\\n]*)+)\\|\\s*$`, "gim"))) {
      const nums = [...m[1]!.matchAll(/\*{0,2}([0-9]{1,4})\*{0,2}/g)].map((x) => Number(x[1]));
      if (nums.length > 0) found.push(nums[nums.length - 1]!);
    }
    return found;
  };
  const hC = headlineFor(/BUILT-AND-CORRECT/);
  const hW = headlineFor(/BUILT-BUT-WRONG/);
  const hN = headlineFor(/NOT-BUILT/);
  const hX = headlineFor(/CANNOT-VERIFY/);
  const statedHeadline =
    hC.length > 0 && hW.length > 0 && hN.length > 0 && hX.length > 0
      ? { c: hC[hC.length - 1]!, w: hW[hW.length - 1]!, n: hN[hN.length - 1]!, x: hX[hX.length - 1]! }
      : null;

  return {
    file,
    rows,
    allDenominators: uniqueDenoms,
    revised,
    nonVerdictRows,
    hypotheticalRows,
    counts,
    statedDenominator,
    statedHeadline,
    duplicates,
    hasCorrectionHeader: /CORRECTION HEADER/i.test(text),
  };
}

const files = readdirSync(CENSUS_DIR).filter((f) => f.startsWith("census-") && f.endsWith(".md")).sort();
const problems: string[] = [];
const results: CensusResult[] = [];

for (const f of files) {
  const r = parseCensus(f, readFileSync(join(CENSUS_DIR, f), "utf8"));
  results.push(r);

  if (r.rows.length < MIN_ROWS_PER_CENSUS) {
    problems.push(`::error::${f}: no verdict rows could be parsed at all. Either the table shape changed or this file is not a census; either way its headline is unverifiable.`);
    continue;
  }
  for (const d of r.duplicates) {
    problems.push(`::error::${f}: requirement id "${d.id}" appears on ${d.lines.length} rows (lines ${d.lines.join(", ")}). One of them is double-counted or uncounted, and no reader of the headline would see it.`);
  }
  if (r.statedDenominator !== null && r.rows.length > r.statedDenominator) {
    problems.push(`::error::${f}: ${r.rows.length} verdict rows parsed but the stated denominator is ${r.statedDenominator}. More rows than requirements is arithmetically impossible — one of the two is wrong.`);
  }

  // ── A HEADLINE THAT DOES NOT SUM TO ITS OWN DENOMINATOR ──────────────────
  //
  // The general rule is that a stated headline need NOT equal the parsed
  // counts, because requirements counted in prose are real and unparseable.
  // That exemption does not apply when there IS no prose gap: if every
  // requirement in the denominator was parsed, then C + W + N + X must equal
  // the denominator, and a headline that does not is arithmetic, not judgement.
  //
  // Found by hand on 2026-09-08 in census-layover: a headline of 27 + 133 + 139
  // against a denominator of 296 — 299. It survived because the pass that wrote
  // it ADDED its own moves to the previous headline instead of counting the
  // rows, which carries any earlier error forward while looking freshly
  // measured. The census is now corrected; this is the check that would have
  // caught it.
  const parsedTotal = r.rows.length;
  if (r.statedDenominator !== null && parsedTotal === r.statedDenominator && r.statedHeadline) {
    const h = r.statedHeadline;
    const sum = h.c + h.w + h.n + h.x;
    if (sum !== r.statedDenominator) {
      problems.push(
        `::error::${f}: its stated headline sums to ${sum} (C ${h.c} + W ${h.w} + N ${h.n} + X ${h.x}) against a ` +
          `denominator of ${r.statedDenominator}, and EVERY requirement in that denominator was parsed — there is no ` +
          `prose gap for the difference to live in. A headline arrived at by adding this pass's moves to the previous ` +
          `headline carries the previous headline's error forward while looking freshly measured. Count the rows: ` +
          `C ${r.counts.C} / W ${r.counts.W} / N ${r.counts.N} / X ${r.counts.X}.`,
      );
    }
  }
}

if (files.length < MIN_CENSUS_FILES) {
  problems.push(`::error::found ${files.length} census file(s) under docs/architecture/, expected at least ${MIN_CENSUS_FILES} — this check did not find the censuses it claims to have read.`);
}

for (const p of problems) console.error(p);

console.log("\nPer-census verdict counts, recomputed from the tables:\n");
console.log(`  ${"census".padEnd(28)} ${"rows".padStart(5)} ${"C".padStart(5)} ${"W".padStart(5)} ${"N".padStart(5)} ${"X".padStart(4)}  ${"denom".padStart(6)}  unreconciled`);
let totalRows = 0;
let totalGap = 0;
for (const r of results) {
  totalRows += r.rows.length;
  const gap = r.statedDenominator === null ? null : r.statedDenominator - r.rows.length;
  if (gap !== null) totalGap += gap;
  const name = r.file.replace(/^census-|\.md$/g, "");
  console.log(
    `  ${name.padEnd(28)} ${String(r.rows.length).padStart(5)} ${String(r.counts.C).padStart(5)} ${String(r.counts.W).padStart(5)} ${String(r.counts.N).padStart(5)} ${String(r.counts.X).padStart(4)}  ` +
      `${(r.statedDenominator ?? "—").toString().padStart(6)}  ${gap === null ? "denominator not stated in a parseable form" : `${gap} counted where this tool cannot read`}` +
      `${r.allDenominators.length > 1 ? ` [states ${r.allDenominators.length} denominators: ${r.allDenominators.join(", ")} — scored against more than one population on purpose]` : ""}` +
      `${r.revised.length > 0 ? ` [${r.revised.length} row(s) revised by a later recount; last statement taken]` : ""}` +
      `${r.nonVerdictRows > 0 ? ` [${r.nonVerdictRows} id-keyed row(s) carry no verdict — not verdict tables, not counted]` : ""}` +
      `${r.hypotheticalRows > 0 ? ` [${r.hypotheticalRows} row(s) in a PR-comparison table — skipped, they describe UNMERGED work]` : ""}` +
      `${r.hasCorrectionHeader ? "  [carries a CORRECTION HEADER]" : ""}`,
  );
}

console.log(
  `\nNOTE: ${files.length} census file(s) read; ${totalRows} verdict row(s) parsed; ${totalGap} requirement(s) across all ` +
    `censuses are counted somewhere this tool cannot read (prose blocks that enumerate several requirements in one ` +
    `paragraph — a legitimate way to count them and an impossible one to parse).`,
);
console.log(
  `NOTE: DOES NOT COVER, stated rather than implied: (1) whether a verdict is CORRECT — this checks that the document ` +
    `agrees with itself, not that it agrees with the code; (2) the prose-counted requirements above; (3) whether the ` +
    `stated headline percentages match the parsed counts EXCEPT where a census has no prose gap at all (parsed rows = ` +
    `stated denominator), where the headline must sum to the denominator and is checked; elsewhere the prose gap makes a ` +
    `mismatch expected rather than wrong. ${results.filter((r) => r.hasCorrectionHeader).length} of ${files.length} ` +
    `censuses already carry a correction header saying their own headline had drifted from their own body — that is ` +
    `the failure mode this file exists to make harder, not one it can claim to have closed.`,
);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log("\ncheck:census-integrity PASSED");
