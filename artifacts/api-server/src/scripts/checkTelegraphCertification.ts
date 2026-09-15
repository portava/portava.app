/**
 * check:telegraph-certification — the guard over Telegraph's §26/§27 certification.
 *
 * WHY THIS EXISTS
 * ---------------
 * A certification plan is a document until something can make it go red. This
 * repository already learned that lesson one level down: check:guard-reachability
 * exists because a checker nobody runs is decorative architecture. The same
 * defect applies to a test matrix that lives only in a spec — the ten §26 rows
 * and the twenty-five §27 entries were, at the last census, entirely unbuilt or
 * satisfied incidentally by case tests written for other reasons, and nothing
 * anywhere would have noticed if they stopped being satisfied.
 *
 * WHAT IT ENFORCES — five rules, each of which has a failure it prevents:
 *
 *   1. COMPLETENESS. Exactly ten §26 cases, seven §27.1 properties, twelve
 *      §27.2 fixtures and six §27.3 contracts, with the ids the spec's order
 *      implies and one distinct census row each. Prevents: a case being dropped
 *      from the matrix to make a red suite green.
 *
 *   2. CITATIONS RESOLVE. Every `enforcedBy` path exists on disk. Prevents: a
 *      declaration that cites a module someone deleted or renamed — the exact
 *      rot the census's own doc-citation checker exists to stop, applied to the
 *      machine-readable half.
 *
 *   3. SCRIPTS EXIST. Every §27.3 `checkScript` names a script in package.json.
 *      Prevents: a live-DB contract that claims a standing lane enforces it
 *      after that lane has been renamed out from under it.
 *
 *   4. EVERY ENTRY IS EXERCISED. Each id appears verbatim in its suite file.
 *      Prevents: a declaration with no test — the "we have a matrix" claim that
 *      nothing executes.
 *
 *   5. THE UNENFORCED SET MAY ONLY SHRINK. The number of entries whose status
 *      is not `enforced` is pinned per family in
 *      TELEGRAPH_CERTIFICATION_BASELINE.json. Prevents: the failure mode that
 *      matters most — a future change quietly reclassifying an `enforced` case
 *      as `divergent` instead of fixing it. Lowering a count requires editing
 *      the baseline, which is a visible, reviewable act; raising one is
 *      refused.
 *
 * WHAT IT DOES NOT DO, stated rather than implied: it does not check that a
 * status is RIGHT. `enforced` is a claim about the tree that only the suite can
 * settle, and the suites are what settle it. This checks that the claim is
 * complete, cited, executed and monotone.
 *
 * Exit codes: 0 pass, 1 at least one rule violated. Static — no database, no
 * credentials, runs on every push.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { TELEGRAPH_RLS_MATRIX } from "../domain/telegraph/invariants/rlsAuthorizationMatrix.js";
import { TELEGRAPH_PROPERTY_INVARIANTS } from "../domain/telegraph/invariants/propertyInvariants.js";
import { TELEGRAPH_ADVERSARIAL_FIXTURES } from "../domain/telegraph/invariants/adversarialFixtures.js";
import { TELEGRAPH_LIVE_DB_CONTRACTS } from "../domain/telegraph/invariants/liveDbContracts.js";
import type { CertificationEntry } from "../domain/telegraph/contracts/certification.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "../..");
const REPO_ROOT = resolve(PKG_ROOT, "../..");
const BASELINE_PATH = resolve(__dirname, "TELEGRAPH_CERTIFICATION_BASELINE.json");

interface Family {
  key: string;
  label: string;
  specSection: string;
  entries: readonly CertificationEntry[];
  expectedCount: number;
  idPrefix: string;
  testFile: string;
}

const FAMILIES: Family[] = [
  {
    key: "rlsMatrix",
    label: "§26 RLS & Authorization Test Matrix",
    specSection: "26",
    entries: TELEGRAPH_RLS_MATRIX,
    expectedCount: 10,
    idPrefix: "RLS-",
    testFile: "src/test/telegraphRlsAuthorizationMatrix.test.ts",
  },
  {
    key: "propertyInvariants",
    label: "§27.1 Property invariants",
    specSection: "27.1",
    entries: TELEGRAPH_PROPERTY_INVARIANTS,
    expectedCount: 7,
    idPrefix: "P-",
    testFile: "src/test/telegraphPropertyInvariants.test.ts",
  },
  {
    key: "adversarialFixtures",
    label: "§27.2 Adversarial fixtures",
    specSection: "27.2",
    entries: TELEGRAPH_ADVERSARIAL_FIXTURES,
    expectedCount: 12,
    idPrefix: "F-",
    testFile: "src/test/telegraphAdversarialFixtures.test.ts",
  },
  {
    key: "liveDbContracts",
    label: "§27.3 Live-DB contract checks",
    specSection: "27.3",
    entries: TELEGRAPH_LIVE_DB_CONTRACTS,
    expectedCount: 6,
    idPrefix: "LDB-",
    testFile: "src/test/telegraphRlsAuthorizationMatrix.test.ts",
  },
];

const problems: string[] = [];
const notes: string[] = [];

function pkgScripts(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(resolve(PKG_ROOT, "package.json"), "utf8"));
  return pkg.scripts ?? {};
}

/** Resolve a declared path against the package root, then the repo root. */
function citationExists(p: string): boolean {
  return existsSync(resolve(PKG_ROOT, p)) || existsSync(resolve(REPO_ROOT, p));
}

const scripts = pkgScripts();
const unenforced: Record<string, number> = {};

for (const fam of FAMILIES) {
  // 1. Completeness.
  if (fam.entries.length !== fam.expectedCount) {
    problems.push(
      `${fam.label}: declares ${fam.entries.length} entries, the spec has ${fam.expectedCount}. ` +
        `A certification family that can shed an entry can be made green by deletion.`,
    );
  }
  const ids = fam.entries.map((e) => e.id);
  if (new Set(ids).size !== ids.length) {
    problems.push(`${fam.label}: duplicate ids — ${ids.join(", ")}`);
  }
  for (const id of ids) {
    if (!id.startsWith(fam.idPrefix)) {
      problems.push(`${fam.label}: id "${id}" does not carry the family prefix "${fam.idPrefix}"`);
    }
  }
  const rows = fam.entries.map((e) => e.censusRow);
  if (new Set(rows).size !== rows.length) {
    problems.push(
      `${fam.label}: two entries claim the same census row (${rows.join(", ")}). ` +
        `One row, one entry — otherwise a census move cannot be attributed.`,
    );
  }

  // 2. Citations resolve.
  for (const e of fam.entries) {
    if (e.enforcedBy.length === 0) {
      problems.push(`${e.id}: declares no enforcing artifact. A claim with no citation is prose.`);
    }
    for (const path of e.enforcedBy) {
      if (!citationExists(path)) {
        problems.push(`${e.id}: enforcedBy cites "${path}", which does not exist on disk.`);
      }
    }
    if (!e.note || e.note.length < 80) {
      problems.push(
        `${e.id}: note is ${e.note?.length ?? 0} characters. Every entry must say what it ` +
          `establishes and, when not enforced, exactly what would close it.`,
      );
    }
  }

  // 3. Live-DB scripts exist.
  if (fam.key === "liveDbContracts") {
    for (const e of TELEGRAPH_LIVE_DB_CONTRACTS) {
      if (e.checkScript && !scripts[e.checkScript]) {
        problems.push(
          `${e.id}: names package script "${e.checkScript}", which is not in package.json. ` +
            `A contract pointing at a lane nobody can run is not a contract.`,
        );
      }
    }
  }

  // 4. Every entry is exercised.
  const testPath = resolve(PKG_ROOT, fam.testFile);
  if (!existsSync(testPath)) {
    problems.push(`${fam.label}: suite "${fam.testFile}" does not exist.`);
  } else {
    const suite = readFileSync(testPath, "utf8");
    for (const e of fam.entries) {
      if (!suite.includes(e.id)) {
        problems.push(
          `${e.id}: declared but never named in ${fam.testFile}. ` +
            `A declaration nothing executes is exactly what this checker exists to refuse.`,
        );
      }
    }
  }

  unenforced[fam.key] = fam.entries.filter((e) => e.status !== "enforced").length;
}

// 5. The unenforced set may only shrink.
if (!existsSync(BASELINE_PATH)) {
  problems.push(
    `TELEGRAPH_CERTIFICATION_BASELINE.json is missing. Without it the shrink-only rule ` +
      `cannot be applied and a divergence could be introduced silently.`,
  );
} else {
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as {
    unenforced: Record<string, number>;
  };
  for (const fam of FAMILIES) {
    const now = unenforced[fam.key];
    const was = baseline.unenforced?.[fam.key];
    if (was === undefined) {
      problems.push(`${fam.label}: no baseline entry for "${fam.key}".`);
      continue;
    }
    if (now > was) {
      const grew = fam.entries.filter((e) => e.status !== "enforced").map((e) => `${e.id}=${e.status}`);
      problems.push(
        `${fam.label}: ${now} entries are not enforced, baseline allows ${was}. ` +
          `RATCHET VIOLATED — the set of things this tree does not do grew. ` +
          `Current: ${grew.join(", ")}`,
      );
    } else if (now < was) {
      notes.push(
        `${fam.label}: ${now} unenforced, baseline ${was}. An entry was CLOSED — ` +
          `lower the baseline in the same commit so the gain cannot be given back silently.`,
      );
      problems.push(
        `${fam.label}: baseline says ${was} unenforced, reality is ${now}. ` +
          `A baseline above reality makes the ratchet slack by ${was - now}. Re-record it.`,
      );
    }
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

console.log("Telegraph §26/§27 certification");
console.log("");
for (const fam of FAMILIES) {
  const byStatus: Record<string, number> = {};
  for (const e of fam.entries) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
  const parts = Object.entries(byStatus)
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(`  ${fam.label.padEnd(42)} ${String(fam.entries.length).padStart(2)} entries   ${parts}`);
}
const totalEntries = FAMILIES.reduce((n, f) => n + f.entries.length, 0);
const totalCitations = FAMILIES.reduce(
  (n, f) => n + f.entries.reduce((m, e) => m + e.enforcedBy.length, 0),
  0,
);
console.log(
  `  ${totalEntries} certification entries inspected across ${FAMILIES.length} families ` +
    `(${totalCitations} citations resolved)`,
);
console.log("");
for (const n of notes) console.log(`  NOTE: ${n}`);

if (problems.length > 0) {
  console.error("");
  console.error(`check:telegraph-certification FAILED — ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ✘ ${p}`);
  process.exit(1);
}

console.log("check:telegraph-certification PASSED");
console.log(
  "  Covers: completeness, citation resolution, script existence, test coverage and the",
);
console.log(
  "  shrink-only ratchet on unenforced entries. Does NOT verify that a status is correct —",
);
console.log("  that is what the three suites do, and they are what a status is a claim about.");
