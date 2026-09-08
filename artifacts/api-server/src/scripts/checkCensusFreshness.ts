/**
 * checkCensusFreshness — a stale census must not be quotable as current truth.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 * This is a repeated failure in this repository, not a hypothetical. Two
 * censuses sat at numbers measured hundreds of commits earlier and were read
 * as present-tense fact:
 *
 *   census-layover.md              31.4% constructed / 3.4% correct
 *   census-highlights-memories.md  28.6% constructed / 6.4% correct
 *
 * Both were quoted while the architecture they measured had moved substantially.
 * When they were finally re-measured against HEAD, layover went to 50.0% / 8.4%
 * and highlights to 52.3% / 6.0% — one of them DOWN on correctness, because a
 * miscitation was corrected. The direction is not the point. The point is that
 * nothing in the repository could tell the difference between a census that had
 * been checked yesterday and one that had not been checked since June.
 *
 * ── THE CONTRACT ─────────────────────────────────────────────────────────────
 * A census declares `head_commit`. This check asks git whether any file that
 * census COUNTS has changed since that commit. If so the census is stale, and
 * the remedy is either a re-measure or a written acknowledgement saying why the
 * change cannot have moved a verdict.
 *
 * PATH-SCOPED ON PURPOSE. A README edit, a doc change, or work on an unrelated
 * surface must not age a census — a guard that cries stale on every commit gets
 * switched off, and then the real staleness comes back. Each census declares
 * the paths it is a measurement OF.
 *
 * ── THE ACKNOWLEDGEMENT LEDGER IS NOT A MUTE BUTTON ──────────────────────────
 *
 * It was one, for four commits, and the hole is worth stating because the header
 * had claimed otherwise the whole time. An acknowledgement was keyed on
 * (census, since) alone, so it silenced EVERY later change to that census's
 * counted files rather than the one whose harmlessness had been argued. An entry
 * written to cover a single comment-only change was, four commits later, quietly
 * covering four changed files, three of which nobody had looked at — while its
 * `reason` still read as though it described the whole silence. An entry now
 * covers exactly the paths it NAMES, an entry that names none covers none, and a
 * counted file that changed without being named makes the census stale again.
 * An entry names a commit range and says why the verdicts cannot have moved.
 * "Not relevant" is not a reason. The entry is validated: it must name a census
 * that exists, its `since` must be the census's CURRENT head_commit (so an
 * acknowledgement cannot outlive the measurement it was written against), and
 * it must carry a reason long enough to be a reason.
 *
 * ── WHAT IT DOES NOT COVER, STATED RATHER THAN IMPLIED ───────────────────────
 * (1) Whether the census's VERDICTS are right. It checks age, not accuracy.
 *     check:census-integrity checks that a census agrees with itself; neither
 *     checks it against the code.
 * (2) A census with no `head_commit` cannot be checked at all — those are
 *     REPORTED by name rather than passed silently, because an unmeasurable
 *     census is the weakest state of the three, not the safest.
 * (3) Renames. `git diff --name-only` reports the new path; a file moved out of
 *     a counted directory stops ageing its census.
 *
 * Run: node --import tsx/esm src/scripts/checkCensusFreshness.ts
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const CENSUS_DIR = join(REPO, "docs/architecture");
const LEDGER = new URL("./CENSUS_STALENESS_ACKNOWLEDGED.json", import.meta.url).pathname;

/** A run that found no censuses is a run that found nothing. */
const MIN_CENSUS_FILES = 10;

/**
 * What each census is a measurement OF. A census not listed here is reported as
 * unscoped rather than silently treated as fresh — the scope is the thing that
 * makes the check meaningful, and a missing one is a gap, not a pass.
 */
const CENSUS_SCOPE: Record<string, string[]> = {
  "census-layover.md": [
    "artifacts/api-server/src/services/airport/",
    "artifacts/api-server/src/routes/airport.ts",
    "travel-buddy-standalone/src/services/layover.ts",
    "travel-buddy-standalone/src/components/layover/",
    "travel-buddy-standalone/app/layover/",
  ],
  "census-highlights-memories.md": [
    "artifacts/api-server/src/routes/memories.ts",
    "artifacts/api-server/src/routes/highlights.ts",
    "artifacts/api-server/src/routes/stories.ts",
    "artifacts/api-server/src/services/memory/",
    "artifacts/api-server/src/services/memoryProjections/",
    "artifacts/api-server/src/services/memoryRetrieval/",
    "artifacts/api-server/src/services/highlights/",
    "artifacts/api-server/src/lib/memoryCommandBus.ts",
    "artifacts/api-server/src/lib/memoryOutbox.ts",
    "artifacts/api-server/src/lib/highlightPermissions.ts",
  ],
  // Trust has NO SPEC — its 52 requirements are 20 inbound obligations from
  // other surfaces' specs plus 32 contracts its own code asserts. That makes the
  // scope wider than one directory: the rows about whether OTHER surfaces
  // consume Trust correctly (A13, A17) are aged by the files that consume it,
  // not by services/trust. Listing only the service would have made this census
  // look fresh while the reads it grades moved underneath it.
  "census-trust.md": [
    "artifacts/api-server/src/services/trust/",
    "artifacts/api-server/src/lib/trustScore.ts",
    "artifacts/api-server/src/lib/trustMaintenanceScheduler.ts",
    "artifacts/api-server/src/routes/trust-admin.ts",
    // The consumers A13 and A17 grade.
    "artifacts/api-server/src/routes/events.ts",
    "artifacts/api-server/src/routes/pulse.ts",
    "artifacts/api-server/src/routes/rentABuddyMarketplace.ts",
    "artifacts/api-server/src/routes/tripCrewLocation.ts",
    "artifacts/api-server/src/compass/CompassProfileService.ts",
    "artifacts/api-server/src/compass/CompassTools.ts",
    "artifacts/api-server/src/compass/CompassActiveUserRewardEngine.ts",
    "artifacts/api-server/src/services/ranking/CreatorActivityScoreService.ts",
    // The emitters C32 and A6 grade.
    "artifacts/api-server/src/services/hiddenGems/",
    "artifacts/api-server/src/services/passport/StampAwardEngine.ts",
    "artifacts/api-server/src/services/passport/PassportStampService.ts",
  ],
  // The Wall's 205 requirements are graded against a scope DELIBERATELY wider
  // than services/wall/ + features/wall/, for the reason §3 of that census
  // spells out: the Wall owns almost no state of its own by design (§30) and
  // rides on other surfaces' canonical systems. Its verdicts are therefore aged
  // by files it does not own —
  //   • lib/wallProjection.ts is the contract every verdict about a projection,
  //     truth class or promotion disclosure is graded against, and it lives in
  //     lib/, not services/wall/;
  //   • lib/liveClaimRead.ts is the whole of the Live For You strip's evidence
  //     (W122-W131) and its three fail-closed gates;
  //   • lib/intelContracts.ts owns SOURCE_CLASSES and SOURCE_CLASS_LABELS, which
  //     W178's disclosure is required to agree with;
  //   • routes/mediaFeed.ts owns post_saves, the canonical store behind W7's
  //     `save` — a Wall verdict that would go wrong if that endpoint moved.
  // Listing only the two Wall directories would have made this census look fresh
  // while the contracts it grades moved underneath it — the same trap the trust
  // scope above avoids.
  "census-wall.md": [
    "artifacts/api-server/src/services/wall/",
    "artifacts/api-server/src/routes/wall.ts",
    "artifacts/api-server/src/lib/wallProjection.ts",
    "artifacts/api-server/src/lib/liveClaimRead.ts",
    "artifacts/api-server/src/lib/intelContracts.ts",
    "artifacts/api-server/src/routes/mediaFeed.ts",
    "travel-buddy-standalone/src/features/wall/",
  ],
};

interface Ack {
  census: string;
  since: string;
  reason: string;
  /**
   * The counted files this acknowledgement covers, repo-relative.
   *
   * WITHOUT THIS THE LEDGER WAS A MUTE BUTTON AFTER ALL. An acknowledgement was
   * keyed on (census, since) alone, so it silenced EVERY subsequent change to
   * that census's files — not just the one whose harmlessness had been argued.
   * Measured 2026-09-08: an entry written to cover ONE comment-only change to
   * lib/memoryOutbox.ts was, four commits later, quietly covering FOUR changed
   * files, three of which nobody had looked at. The reason field still read as
   * though it described the whole silence.
   *
   * Now an acknowledgement covers exactly the paths it names, and a counted file
   * that changed and is NOT named makes the census stale again.
   */
  files?: readonly string[];
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}

const files = readdirSync(CENSUS_DIR).filter((f) => f.startsWith("census-") && f.endsWith(".md")).sort();
const problems: string[] = [];

const acks: Ack[] = existsSync(LEDGER)
  ? (JSON.parse(readFileSync(LEDGER, "utf8")).acknowledged ?? [])
  : [];

const head = git(["rev-parse", "HEAD"]);
let checked = 0;
let stale = 0;
let unscoped = 0;
let undeclared = 0;
const rows: string[] = [];

for (const f of files) {
  const text = readFileSync(join(CENSUS_DIR, f), "utf8");
  const m = /head_commit`?\s*\|\s*`?([0-9a-f]{7,40})/i.exec(text);
  if (!m) {
    undeclared++;
    rows.push(`  ${f.padEnd(34)} no head_commit declared — CANNOT BE CHECKED`);
    continue;
  }
  const commit = m[1]!;
  const scope = CENSUS_SCOPE[f];
  if (!scope) {
    unscoped++;
    rows.push(`  ${f.padEnd(34)} declares ${commit.slice(0, 8)} but has no scope in CENSUS_SCOPE — CANNOT BE CHECKED`);
    continue;
  }
  checked++;

  let changed: string[];
  try {
    changed = git(["diff", "--name-only", `${commit}..${head}`, "--", ...scope]).split("\n").filter(Boolean);
  } catch {
    problems.push(`::error::${f}: git could not diff ${commit}..HEAD — the declared head_commit may not exist in this clone.`);
    continue;
  }

  if (changed.length === 0) {
    rows.push(`  ${f.padEnd(34)} FRESH at ${commit.slice(0, 8)} (0 counted files changed)`);
    continue;
  }

  const ack = acks.find((a) => a.census === f);
  if (ack && ack.since === commit) {
    // An acknowledgement covers the paths it NAMES and nothing else. An entry
    // with no `files` covers nothing, which is the honest reading of a ledger
    // written before the field existed -- it is not grandfathered in.
    const covered = new Set(ack.files ?? []);
    const uncovered = changed.filter((c) => !covered.has(c));
    if (uncovered.length === 0) {
      rows.push(
        `  ${f.padEnd(34)} ${changed.length} counted file(s) changed — ACKNOWLEDGED (all named)`,
      );
      continue;
    }
    stale++;
    problems.push(
      `::error::${f} is STALE. Its acknowledgement covers ${covered.size} named file(s), but ` +
        `${uncovered.length} counted file(s) changed that it does NOT name:\n    ${uncovered.slice(0, 8).join("\n    ")}` +
        (uncovered.length > 8 ? `\n    …and ${uncovered.length - 8} more` : "") +
        `\n  An acknowledgement silences the changes whose harmlessness it ARGUES, not every change that ` +
        `happens to follow it. Either name these files and say why they cannot have moved a verdict, or ` +
        `re-measure the census.`,
    );
    continue;
  }
  stale++;
  problems.push(
    `::error::${f} is STALE. It declares head_commit ${commit.slice(0, 8)}, and ${changed.length} file(s) it counts have ` +
      `changed since:\n    ${changed.slice(0, 8).join("\n    ")}` +
      (changed.length > 8 ? `\n    …and ${changed.length - 8} more` : "") +
      `\n  Its headline percentages therefore describe a tree that no longer exists, and anyone quoting them is quoting ` +
      `history. Re-measure it against HEAD and update head_commit, or add an entry to ` +
      `src/scripts/CENSUS_STALENESS_ACKNOWLEDGED.json naming this commit as \`since\` and saying why these changes ` +
      `cannot have moved a verdict. "Not relevant" is not a reason.`,
  );
}

// Ledger validation: an acknowledgement must not outlive its measurement.
for (const a of acks) {
  if (!files.includes(a.census)) {
    problems.push(`::error::CENSUS_STALENESS_ACKNOWLEDGED names "${a.census}", which is not a census file. Delete the entry.`);
    continue;
  }
  const text = readFileSync(join(CENSUS_DIR, a.census), "utf8");
  const m = /head_commit`?\s*\|\s*`?([0-9a-f]{7,40})/i.exec(text);
  if (m && m[1] !== a.since) {
    problems.push(
      `::error::CENSUS_STALENESS_ACKNOWLEDGED for ${a.census} names since=${a.since.slice(0, 8)}, but that census now ` +
        `declares head_commit ${m[1]!.slice(0, 8)}. The census was re-measured; the acknowledgement is spent. Delete it.`,
    );
  }
  if ((a.reason ?? "").length < 80) {
    problems.push(
      `::error::CENSUS_STALENESS_ACKNOWLEDGED for ${a.census} carries a ${(a.reason ?? "").length}-character reason. ` +
        `Saying why a code change cannot have moved a verdict takes more than a label.`,
    );
  }
}

if (files.length < MIN_CENSUS_FILES) {
  problems.push(`::error::found ${files.length} census file(s), expected at least ${MIN_CENSUS_FILES} — this check did not find the censuses.`);
}

for (const p of problems) console.error(p);

console.log("\nCensus freshness against HEAD " + head.slice(0, 8) + ":\n");
for (const r of rows) console.log(r);
console.log(
  `\nNOTE: ${files.length} census file(s); ${checked} checkable (declare head_commit AND have a declared scope), ` +
    `${stale} STALE, ${undeclared} declare no head_commit, ${unscoped} declare one but have no scope entry. ` +
    `The last two are NOT passes — an unmeasurable census is the weakest of the three states, and they are named above.`,
);
console.log(
  `NOTE: DOES NOT COVER — (1) whether a census's verdicts are RIGHT; this checks age, not accuracy, and ` +
    `check:census-integrity checks only that a census agrees with itself. Neither checks a census against the code. ` +
    `(2) Renames: git reports the new path, so a file moved out of a counted directory stops ageing its census.`,
);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log("\ncheck:census-freshness PASSED");
