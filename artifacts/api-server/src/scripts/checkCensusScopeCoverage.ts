/**
 * checkCensusScopeCoverage — a census must WATCH the files it CITES.
 *
 * ── THE DEFECT THIS GENERALISES ──────────────────────────────────────────────
 * `check:census-freshness` asks whether any file a census COUNTS has changed
 * since it was measured. What a census counts is declared by hand in
 * `CENSUS_SCOPE`. Nothing checked that declaration against the census itself.
 *
 * Measured 2026-09-11 on census-trips, before its scope was widened: the
 * document cited 49 distinct files and 10 were in scope. The 39 missing were
 * led by `lib/tripCrewLocation.ts` (34 citations), `routes/trips-expansion.ts`
 * (28) and `compass/CompassTools.ts` (26). The scope covered the Trip Kernel
 * migrations — the programme that was being BUILT — so it watched the rows
 * saying something is not yet right, and left unguarded the rows claiming
 * something IS right. That is the wrong way round: a W row that rots stays
 * wrong, but a C row that rots becomes a false assurance, and `census-freshness`
 * reported FRESH throughout, truthfully, about the wrong half.
 *
 * ── WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────
 * It compares the set of repo files a census cites against the paths its
 * CENSUS_SCOPE entry covers, and reports the uncovered ones ranked by how often
 * they are cited. It does NOT:
 *   (1) say a verdict is right — no guard in this repository does;
 *   (2) demand 100% coverage. A census legitimately cites files it does not
 *       grade: a sibling census's evidence, a migration quoted for contrast, a
 *       guard script named as machinery. So this reports a RATIO and enforces a
 *       per-census FLOOR that can only be raised, rather than asserting that
 *       every citation must be watched.
 *   (3) resolve a bare basename that matches more than one file. census-trips
 *       §37 nearly recorded a false finding that way — three files share
 *       `0041_trip_crew_location.sql` and they disagree. Ambiguous basenames are
 *       counted separately and never treated as covered or uncovered.
 *
 * The floors live in CENSUS_SCOPE_FLOORS below. Raising one is a deliberate
 * commit; the check fails if coverage drops below it, which is what stops a
 * census from growing new citations into unwatched files.
 *
 * Run: node --import tsx/esm src/scripts/checkCensusScopeCoverage.ts
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const CENSUS_DIR = join(REPO, "docs/architecture");

/**
 * Minimum fraction of a census's RESOLVED citations that its scope must cover.
 * A floor is a ratchet: raise it when you widen a scope, never lower it to get
 * green. A census with no scope entry is not floored here — `census-freshness`
 * already reports it as unmeasurable, which is the louder complaint.
 */
const CENSUS_SCOPE_FLOORS: Record<string, number> = {
  // Set 2026-09-11 at each census's MEASURED coverage, rounded down by ~2
  // points so a citation added to an already-watched file cannot trip the
  // check. These are starting lines, not targets: every one of them is a
  // statement that most of what the census cites is NOT watched for staleness.
  // The honest reading of this table is that the guard currently protects a
  // minority of each census, and knowing that is the point of measuring it.
  "census-compass.md": 0.54,
  "census-discovery.md": 0.96,   // widened 2026-09-11: 22% -> 98%
  "census-highlights-memories.md": 0.27,
  "census-input-intelligence.md": 0.26,
  "census-layover.md": 0.31,
  "census-map.md": 0.67,
  "census-media.md": 0.68,
  "census-sensing.md": 0.90,   // widened 2026-09-11: 16% -> 92%
  "census-telegraph.md": 0.87,   // widened 2026-09-11: 21% -> 89%
  "census-trips.md": 0.30,
  "census-trust.md": 0.94,   // widened 2026-09-11: 31% -> 96%
  "census-wall.md": 0.61,
};

/** Extract repo-relative-looking file citations from a census. */
const CITE_RE = /`([A-Za-z0-9_./-]+\.(?:ts|tsx|sql|mjs|js|json|yml))(?::[0-9,\-#A-Za-z_]*)?`/g;

function repoFiles(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const listed = execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n").filter(Boolean);
  for (const p of listed) {
    const base = posix.basename(p);
    if (!out.has(base)) out.set(base, []);
    out.get(base)!.push(p);
  }
  return out;
}

function loadScopes(): Record<string, string[]> {
  const src = readFileSync(join(REPO, "artifacts/api-server/src/scripts/checkCensusFreshness.ts"), "utf8");
  const start = src.indexOf("const CENSUS_SCOPE");
  const end = src.indexOf("\n};", start) + 3;
  const block = src.slice(start, end).replace("const CENSUS_SCOPE: Record<string, string[]> =", "return");
  // eslint-disable-next-line no-new-func
  return new Function(block)() as Record<string, string[]>;
}

const byBase = repoFiles();
const scopes = loadScopes();
const files = readdirSync(CENSUS_DIR).filter((f) => f.startsWith("census-") && f.endsWith(".md")).sort();
const problems: string[] = [];
const rows: string[] = [];

for (const f of files) {
  const text = readFileSync(join(CENSUS_DIR, f), "utf8");
  const counts = new Map<string, number>();
  let ambiguous = 0;
  let unresolved = 0;
  for (const m of text.matchAll(CITE_RE)) {
    const cited = m[1]!;
    let resolved: string | null = null;
    if (existsSync(join(REPO, cited)) && statSync(join(REPO, cited)).isFile()) {
      resolved = cited;
    } else {
      const hits = byBase.get(posix.basename(cited)) ?? [];
      const narrowed = cited.includes("/") ? hits.filter((h) => h.endsWith(cited)) : hits;
      if (narrowed.length === 1) resolved = narrowed[0]!;
      else if (narrowed.length > 1) { ambiguous++; continue; }
      else { unresolved++; continue; }
    }
    counts.set(resolved, (counts.get(resolved) ?? 0) + 1);
  }

  const scope = scopes[f];
  if (!scope) {
    rows.push(`  ${f.padEnd(34)} no CENSUS_SCOPE entry — not floored here; census-freshness reports it`);
    continue;
  }
  const covered = (p: string) => scope.some((s) => (s.endsWith("/") ? p.startsWith(s) : p === s || p.startsWith(s + "/")));
  const cited = [...counts.keys()];
  const uncovered = cited.filter((p) => !covered(p)).sort((a, b) => (counts.get(b)! - counts.get(a)!));
  const ratio = cited.length === 0 ? 1 : (cited.length - uncovered.length) / cited.length;
  const floor = CENSUS_SCOPE_FLOORS[f];

  rows.push(
    `  ${f.padEnd(34)} ${String(cited.length).padStart(3)} cited · ` +
      `${String(cited.length - uncovered.length).padStart(3)} watched · ` +
      `${(ratio * 100).toFixed(0).padStart(3)}%` +
      (floor != null ? ` (floor ${(floor * 100).toFixed(0)}%)` : " (no floor set)") +
      (ambiguous ? ` · ${ambiguous} ambiguous basename(s) not resolved` : "") +
      (unresolved ? ` · ${unresolved} citation(s) name no file in the tree` : ""),
  );
  if (uncovered.length > 0) {
    for (const p of uncovered.slice(0, 5)) rows.push(`        unwatched ×${counts.get(p)}  ${p}`);
    if (uncovered.length > 5) rows.push(`        …and ${uncovered.length - 5} more`);
  }

  if (floor != null && ratio < floor) {
    problems.push(
      `::error::${f} watches ${(ratio * 100).toFixed(0)}% of the files it cites, below its floor of ` +
        `${(floor * 100).toFixed(0)}%. Either add the uncovered paths to CENSUS_SCOPE in ` +
        `checkCensusFreshness.ts, or — if they are genuinely not what this census grades — say so. ` +
        `Lowering the floor to pass is the one response that is never right.`,
    );
  }
}

for (const p of problems) console.error(p);
console.log("\nCensus scope coverage — files CITED vs files WATCHED for staleness:\n");
for (const r of rows) console.log(r);
console.log(
  `\nNOTE: DOES NOT COVER — (1) whether a verdict is right; nothing here reads a judgement. ` +
    `(2) Whether a WATCHED file's citation is accurate; check:doc-citations does that. ` +
    `(3) Ambiguous basenames, which are reported and skipped rather than guessed — census-trips §37 ` +
    `nearly recorded a false finding by resolving one of three same-named files.`,
);
if (problems.length > 0) { console.error(`\n${problems.length} problem(s) found.`); process.exit(1); }
console.log(`\n${rows.filter((r) => r.includes("cited ·")).length} censuses measured for scope coverage.`);
console.log("\ncheck:census-scope-coverage PASSED");
