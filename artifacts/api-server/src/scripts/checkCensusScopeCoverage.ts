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
 * led by `domain/trips/services/tripCrewLocation.ts` (34 citations), `routes/trips-expansion.ts`
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
 * CENSUS_STALENESS_ACKNOWLEDGED.json must never be scoped by a census: writing
 * an acknowledgement would age every census counting it, requiring another
 * acknowledgement. Measured as a real regress on 2026-09-11.
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
/**
 * SHARED MACHINERY, EXCLUDED FROM EVERY CENSUS'S DENOMINATOR.
 *
 * WHY THIS EXISTS. The failure message below has always offered two responses —
 * add the path to CENSUS_SCOPE, "or, if they are genuinely not what this census
 * grades, say so". The second was not actionable: there was nowhere to say it,
 * so a census that cited a guard script had exactly one way to go green, which
 * was to WATCH that script and thereafter age on every unrelated lane's guard
 * work. Every CENSUS_SCOPE in checkCensusFreshness.ts already refuses that, in
 * a comment, one census at a time. This list makes the convention those comments
 * describe explicit, uniform, and machine-readable.
 *
 * WHY IT CANNOT BE USED TO HIDE A GAP. Nothing here is product code. These are
 * the files a census NAMES as the thing that measured it — the checker, the
 * registry that declares the checker, the package script that runs it, the
 * staleness ledger. A census citing its own SUBJECT can never qualify, because
 * subjects are routes, services, projections, migrations and tests, none of
 * which is in this list. Removing machinery from the denominator can only RAISE
 * a coverage ratio, so no floor below is weakened by it and none was lowered.
 *
 * WHAT WOULD MAKE THIS WRONG (P24): adding a path here that a census actually
 * grades. The defence is that the list is global — a path added for one census
 * silently stops being watched for all thirteen — so it is a loud place to
 * cheat, not a quiet one.
 */
const NOT_GRADED: readonly string[] = [
  "artifacts/api-server/package.json",
  "package.json",
  "travel-buddy-standalone/package.json",
  "artifacts/api-server/src/scripts/guardRegistry.ts",
  "artifacts/api-server/src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json",
  // A guard's own burn-down ledger, the same category as the staleness ledger
  // above and read only by src/scripts/checkUncheckedSupabaseReads.ts. A census
  // names it when a lane it describes DELETED a call site and had to delete the
  // allowlist key with it — the entry is validated on every run, so a stale key
  // fails the checker. That is the census naming the thing that measured it.
  // It is not product code and no census grades it.
  "artifacts/api-server/src/scripts/UNCHECKED_READS_ALLOWLIST.json",
  "artifacts/api-server/src/scripts/checkCensusFreshness.ts",
  "artifacts/api-server/src/scripts/checkCensusScopeCoverage.ts",
  // The citation guard itself. It lives in `scripts/` rather than
  // `src/scripts/` and ends in `.mjs`, so the pattern below does not reach it —
  // the one machinery file in the tree that the convention already covers in
  // spirit and missed in letter. Several censuses name it as the thing that
  // MEASURED their citations; none grades it, and it is not product code.
  "artifacts/api-server/scripts/check-doc-citations.mjs",
  // Its two siblings, added 2026-09-14 for exactly the reason the comment above
  // gives. The MAP lane raised it against itself: census-map names
  // check-citation-symbols as the guard that found sixteen of its mis-pointed
  // citations, and naming it cost that census coverage — so the lane worked
  // around the rule by NOT SPELLING THE FILENAME, which is the wrong fix made by
  // the only lane that could not make the right one. A census should be able to
  // say what measured it.
  "artifacts/api-server/scripts/check-citation-symbols.mjs",
  "artifacts/api-server/scripts/check-citation-targets.mjs",
  ".github/workflows/ci.yml",
  ".github/workflows/live-db.yml",
];

/** A census's own guard is machinery too: `src/scripts/check*.ts` and `audit*.ts`. */
function isMachinery(p: string): boolean {
  if (NOT_GRADED.includes(p)) return true;
  return /^artifacts\/api-server\/src\/scripts\/(check|audit|rlsDispositions|generate)[A-Za-z0-9]*\.ts$/.test(p);
}

const CENSUS_SCOPE_FLOORS: Record<string, number> = {
  // Set 2026-09-11 at each census's MEASURED coverage, rounded down by ~2
  // points so a citation added to an already-watched file cannot trip the
  // check. These are starting lines, not targets: every one of them is a
  // statement that most of what the census cites is NOT watched for staleness.
  // The honest reading of this table is that the guard currently protects a
  // minority of each census, and knowing that is the point of measuring it.
  "census-compass.md": 0.96,   // widened 2026-09-11
  "census-discovery.md": 0.96,   // widened 2026-09-11: 22% -> 98%
  "census-highlights-memories.md": 0.98,   // widened 2026-09-11; RAISED 0.96 -> 0.98 on 2026-09-22 by §Q, which
                                           // added ten paths to this census's scope — its own five suites plus the
                                           // five §P and the body cited and nothing watched (verifyFlowHighlightControls,
                                           // highlightPublicProjectionEnforcement, highlightRouteHarness, 2975 and 2320)
                                           // — taking measured coverage from 96% (135/140, exactly ON the floor and
                                           // one citation from failing) to 99% (142/143). A ratchet, per the rule
                                           // above. Not 1.00: `0179_stamp_criteria_engine.sql` is cited by BASENAME
                                           // with no path and several frozen roots hold that name, so there is no
                                           // single path to watch. That one citation is the whole of the remaining
                                           // gap and checkCensusFreshness.ts records why it is not resolved.
  "census-input-intelligence.md": 0.98,   // widened 2026-09-11; RAISED 0.95 -> 0.98 on 2026-09-13 when §8
                                          // added rankingSignals.ts, fieldInventory.ts, suggestionBadges.ts and
                                          // its two test files to the scope, taking measured coverage to 100%.
  "census-layover.md": 0.97,   // widened 2026-09-11; RAISED 0.90 -> 0.96 on 2026-09-13 when §11's own migration, rollback and three test files were added to its scope, taking it to 100%. A ratchet, per the rule above. RAISED 0.96 -> 0.97 on 2026-09-22 by §27: measured 133/136 = 97.8 %. This check CAUGHT that pass — §27's new citations took it to 93 %, below the 0.96 floor, and the fix was the one the failure message prescribes: `services/layover/` (where `joinCrew`/`createCrew`/`leaveCrew` live, which §27.4 moves L185/L186/L188 to `C` ON) plus migrations 2984, 2985 and 2971, all added to CENSUS_SCOPE rather than the floor being lowered. The three files still unwatched are named and are deliberately not added: `routes/messaging.ts` and `2795_trip_kernel_write_guards.sql` belong to Telegraph and Trips and are cited in passing, and `src/test/docCitations.test.ts` is a guard's own suite that §27.10 names as the thing that fails — machinery this census reports on, not a subject it grades.
  "census-map.md": 0.96,   // widened 2026-09-11
  // SET 2026-09-15, the first floor this census has had: it had no scope entry
  // at all until the measurability pass, and an unscoped census is not floored
  // here — `check:census-freshness` reporting it CANNOT BE CHECKED is the louder
  // complaint. Measured 99% (113 of 114) the moment the scope landed, floored two
  // points down per the ratchet rule above. The one unwatched citation is
  // `src/scripts/lib/censusHeadCommit.ts`, the head_commit parser census-passport
  // §18.2 reads out; it is machinery that NOT_GRADED's pattern does not reach
  // because the pattern stops at `src/scripts/*.ts`. Watching a guard from a
  // census scope is the thing every comment in checkCensusFreshness.ts refuses,
  // so the point is paid rather than the guard scoped. census-passport.md §18.6
  // records it.
  "census-passport.md": 0.97,
  "census-media.md": 0.96,   // widened 2026-09-11
  "census-sensing.md": 0.90,   // widened 2026-09-11: 16% -> 92%
  "census-telegraph.md": 0.87,   // widened 2026-09-11: 21% -> 89%
  "census-trips.md": 0.86,   // widened 2026-09-11
  "census-trust.md": 1.0,   // widened 2026-09-11: 31% -> 96%; RAISED 0.94 -> 1.00 on 2026-09-14 when the Trust lane's identityVerification code, its three suites, 0176 and the one client surface TV-2c cites were added, taking it to 112/112. A ratchet, per the rule above: every file this census names is now watched, so any new citation to an unwatched file fails immediately rather than being absorbed by six points of slack.
  "census-wall.md": 0.95,   // widened 2026-09-11
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
  const allCited = [...counts.keys()];
  const machinery = allCited.filter(isMachinery);
  const cited = allCited.filter((p) => !isMachinery(p));
  const uncovered = cited.filter((p) => !covered(p)).sort((a, b) => (counts.get(b)! - counts.get(a)!));
  const ratio = cited.length === 0 ? 1 : (cited.length - uncovered.length) / cited.length;
  const floor = CENSUS_SCOPE_FLOORS[f];

  rows.push(
    `  ${f.padEnd(34)} ${String(cited.length).padStart(3)} cited · ` +
      `${String(cited.length - uncovered.length).padStart(3)} watched · ` +
      `${(ratio * 100).toFixed(0).padStart(3)}%` +
      (floor != null ? ` (floor ${(floor * 100).toFixed(0)}%)` : " (no floor set)") +
      (ambiguous ? ` · ${ambiguous} ambiguous basename(s) not resolved` : "") +
      (unresolved ? ` · ${unresolved} citation(s) name no file in the tree` : "") +
      (machinery.length ? ` · ${machinery.length} machinery file(s) excluded from the denominator` : ""),
  );
  if (uncovered.length > 0) {
    // Five is the reading limit, not the reporting limit. CENSUS_SCOPE_LIST_ALL=1
    // prints every uncovered path, because the person WIDENING the scope needs
    // the whole list and "…and 12 more" makes them run the check twelve times.
    const show = process.env.CENSUS_SCOPE_LIST_ALL ? uncovered.length : 5;
    for (const p of uncovered.slice(0, show)) rows.push(`        unwatched ×${counts.get(p)}  ${p}`);
    if (uncovered.length > show) rows.push(`        …and ${uncovered.length - show} more (CENSUS_SCOPE_LIST_ALL=1 for all)`);
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
