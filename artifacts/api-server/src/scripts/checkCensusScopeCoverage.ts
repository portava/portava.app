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
import { measureCensusCoverage, resolveAmongCandidates, type Resolution } from "./lib/censusScopeCoverage.js";

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
  // A guard's own TEST file, added 2026-09-23 for the reason the two comments
  // above give, one level further out. `check:unchecked-supabase-reads` is not
  // invoked by `check:all`; it runs inside `scripts/run-security-checks.sh`,
  // which these two suites are what actually executes in CI. So a census that
  // wants to say "this guard is what caught it, and here is where it went red"
  // has to name them — census-trust.md §23.7 does, for a defect that existed
  // only on the merge of two branches and that neither branch's tree could see.
  // They are not product code and no census grades them; naming the thing that
  // measured you should not cost coverage.
  "artifacts/api-server/src/test/securityCheckSuite.test.ts",
  "artifacts/api-server/src/test/uncheckedSupabaseReads.test.ts",
  // The same rule, 2026-09-26: `check:projection-consumers` has no npm script;
  // it runs only inside this suite, which is where it went red in CI when a file
  // named "worker" wrote canonical storage. census-media.md §32.13 names it as
  // the thing that caught that. It grades no media behaviour.
  "artifacts/api-server/src/test/projectionConsumers.test.ts",
  // This checker's own measurement module and its suite (2026-09-27, census-media
  // §32.15). The pattern below stops at src/scripts/*.ts, so lib/ is not reached,
  // and census-media names both as what measured it — under the same rule.
  "artifacts/api-server/src/scripts/lib/censusScopeCoverage.ts",
  "artifacts/api-server/src/test/censusScopeCoverage.test.ts",
  ".github/workflows/ci.yml",
  ".github/workflows/live-db.yml",
];

/** A census's own guard is machinery too: `src/scripts/check*.ts` and `audit*.ts`. */
function isMachinery(p: string): boolean {
  if (NOT_GRADED.includes(p)) return true;
  return /^artifacts\/api-server\/src\/scripts\/(check|audit|rlsDispositions|generate)[A-Za-z0-9]*\.ts$/.test(p);
}

const CENSUS_SCOPE_FLOORS: Record<string, number> = {
  // ALL THIRTEEN AT 1.0 SINCE 2026-09-27 (census-media §32.14). The corrected
  // count (lib/censusScopeCoverage.ts) measured every census at 100% once the
  // coverage lanes watched what each grades and declared, in the census, what
  // each only cites. census-trust set the precedent below: with no slack, a new
  // citation to an unwatched file fails at once — watch it, or say in the census
  // why it is not graded (a declaration that a verdict row refuses outright).
  // Set 2026-09-11 at each census's MEASURED coverage, rounded down by ~2
  // points so a citation added to an already-watched file cannot trip the
  // check. These are starting lines, not targets: every one of them is a
  // statement that most of what the census cites is NOT watched for staleness.
  // The honest reading of this table is that the guard currently protects a
  // minority of each census, and knowing that is the point of measuring it.
  "census-compass.md": 1.0,   // widened 2026-09-11  // RAISED 0.96 -> 1.0 on 2026-09-27 (census-media §32.14): measured 100% under the corrected count.
  "census-discovery.md": 1.0,   // widened 2026-09-11: 22% -> 98%  // RAISED 0.96 -> 1.0 on 2026-09-27 (census-media §32.14): measured 100% under the corrected count.
  "census-highlights-memories.md": 1.0,   // widened 2026-09-11; RAISED 0.96 -> 0.98 on 2026-09-22 by §Q, which  // RAISED 0.98 -> 1.0 on 2026-09-27 (census-media §32.14): measured 100% under the corrected count.
                                           // added ten paths to this census's scope — its own five suites plus the
                                           // five §P and the body cited and nothing watched (verifyFlowHighlightControls,
                                           // highlightPublicProjectionEnforcement, highlightRouteHarness, 2975 and 2320)
                                           // — taking measured coverage from 96% (135/140, exactly ON the floor and
                                           // one citation from failing) to 99% (142/143). A ratchet, per the rule
                                           // above. Not 1.00: `0179_stamp_criteria_engine.sql` is cited by BASENAME
                                           // with no path and several frozen roots hold that name, so there is no
                                           // single path to watch. That one citation is the whole of the remaining
                                           // gap and checkCensusFreshness.ts records why it is not resolved.
  "census-input-intelligence.md": 1.0,   // widened 2026-09-11; RAISED 0.95 -> 0.98 on 2026-09-13 when §8  // RAISED 0.98 -> 1.0 on 2026-09-27 (census-media §32.14): measured 100% under the corrected count.
                                          // added rankingSignals.ts, fieldInventory.ts, suggestionBadges.ts and
                                          // its two test files to the scope, taking measured coverage to 100%.
  "census-layover.md": 1.0,   // widened 2026-09-11; RAISED 0.90 -> 0.96 on 2026-09-13 when §11's own migration, rollback and three test files were added to its scope, taking it to 100%. A ratchet, per the rule above. RAISED 0.96 -> 0.97 on 2026-09-22 by §27: measured 133/136 = 97.8 %. This check CAUGHT that pass — §27's new citations took it to 93 %, below the 0.96 floor, and the fix was the one the failure message prescribes: `services/layover/` (where `joinCrew`/`createCrew`/`leaveCrew` live, which §27.4 moves L185/L186/L188 to `C` ON) plus migrations 2984, 2985 and 2971, all added to CENSUS_SCOPE rather than the floor being lowered. The three files still unwatched are named and are deliberately not added: `routes/messaging.ts` and `2795_trip_kernel_write_guards.sql` belong to Telegraph and Trips and are cited in passing, and `src/test/docCitations.test.ts` is a guard's own suite that §27.10 names as the thing that fails — machinery this census reports on, not a subject it grades.  // RAISED 0.97 -> 1.0 on 2026-09-27 (census-media §32.14): measured 100% under the corrected count.
  "census-map.md": 1.0,   // widened 2026-09-11  // RAISED 0.96 -> 1.0 on 2026-09-27 (census-media §32.14): measured 100% under the corrected count.
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
  "census-passport.md": 1.0,  // RAISED 0.97 -> 1.0 on 2026-09-27 (census-media §32.14): measured 100% under the corrected count.
  "census-media.md": 1.0,   // widened 2026-09-11  // RAISED 0.96 -> 1.0 on 2026-09-27 (census-media §32.14): measured 100% under the corrected count.
  "census-sensing.md": 1.0,   // widened 2026-09-11: 16% -> 92%  // RAISED 0.90 -> 1.0 on 2026-09-27 (census-media §32.14): measured 100% under the corrected count.
  "census-telegraph.md": 1.0,   // widened 2026-09-11: 21% -> 89%  // RAISED 0.87 -> 1.0 on 2026-09-27 (census-media §32.14): measured 100% under the corrected count.
  "census-trips.md": 1.0,   // widened 2026-09-11  // RAISED 0.86 -> 1.0 on 2026-09-27 (census-media §32.14): measured 100% under the corrected count.
  "census-trust.md": 1.0,   // widened 2026-09-11: 31% -> 96%; RAISED 0.94 -> 1.00 on 2026-09-14 when the Trust lane's identityVerification code, its three suites, 0176 and the one client surface TV-2c cites were added, taking it to 112/112. A ratchet, per the rule above: every file this census names is now watched, so any new citation to an unwatched file fails immediately rather than being absorbed by six points of slack.
  "census-wall.md": 1.0,   // widened 2026-09-11  // RAISED 0.95 -> 1.0 on 2026-09-27 (census-media §32.14): measured 100% under the corrected count.
};

// The citation pattern and the per-census NOT-GRADED declarations live in
// lib/censusScopeCoverage.ts, where they are tested. census-media §32.14
// records why: the pattern this file used to hold did not count most anchored
// citations, or any Expo route path, so every ratio it reported was measured
// over a subset of what each census cites.

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
const fileLines = new Map<string, string[]>();
/** Line `n` (1-based) of a repo file, read once per file. */
function lineAt(p: string, n: number): string | undefined {
  let lines = fileLines.get(p);
  if (!lines) {
    try { lines = readFileSync(join(REPO, p), "utf8").split("\n"); } catch { lines = []; }
    fileLines.set(p, lines);
  }
  return lines[n - 1];
}
const scopes = loadScopes();
const files = readdirSync(CENSUS_DIR).filter((f) => f.startsWith("census-") && f.endsWith(".md")).sort();
const problems: string[] = [];
const rows: string[] = [];

for (const f of files) {
  const text = readFileSync(join(CENSUS_DIR, f), "utf8");
  const scope = scopes[f];
  if (!scope) {
    rows.push(`  ${f.padEnd(34)} no CENSUS_SCOPE entry — not floored here; census-freshness reports it`);
    continue;
  }
  const covered = (p: string) => scope.some((s) => (s.endsWith("/") ? p.startsWith(s) : p === s || p.startsWith(s + "/")));
  const isRepoFile = (p: string) => existsSync(join(REPO, p)) && statSync(join(REPO, p)).isFile();
  // The same candidates check:doc-citations builds (resolveCitationPath): every
  // tracked path equal to the citation or ending in "/" + it; a bare basename
  // matches every file of that name. lib/censusScopeCoverage.ts decides among them.
  const resolve = (cited: string, suffix?: string): Resolution => {
    const hits = byBase.get(posix.basename(cited)) ?? [];
    const candidates = cited.includes("/") ? hits.filter((h) => h === cited || h.endsWith("/" + cited)) : hits;
    return resolveAmongCandidates(cited, candidates, suffix, lineAt);
  };
  const m = measureCensusCoverage({ text, resolve, covered, isMachinery, isRepoFile });
  const { counts, ambiguous, unresolved, machinery, declared, cited, uncovered, ratio } = m;
  for (const d of m.declarationProblems) problems.push(`::error::${f} ${d}`);
  const floor = CENSUS_SCOPE_FLOORS[f];

  rows.push(
    `  ${f.padEnd(34)} ${String(cited.length).padStart(3)} cited · ` +
      `${String(cited.length - uncovered.length).padStart(3)} watched · ` +
      `${(ratio * 100).toFixed(0).padStart(3)}%` +
      (floor != null ? ` (floor ${(floor * 100).toFixed(0)}%)` : " (no floor set)") +
      (ambiguous ? ` · ${ambiguous} ambiguous basename(s) not resolved` : "") +
      (unresolved ? ` · ${unresolved} citation(s) name no file in the tree` : "") +
      (machinery.length ? ` · ${machinery.length} machinery file(s) excluded from the denominator` : "") +
      (declared.size ? ` · ${declared.size} declared NOT-GRADED in the census itself` : ""),
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
        `checkCensusFreshness.ts, or — if they are genuinely not what this census grades — say so, ` +
        `with a "- NOT-GRADED: <repo path> — <reason>" line in the census (lib/censusScopeCoverage.ts; ` +
        `refused for any file a verdict row cites). ` +
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
