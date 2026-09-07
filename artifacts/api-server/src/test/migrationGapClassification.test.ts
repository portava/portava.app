/**
 * audit:schema's gap classifier — the rule that separates "not yet applied"
 * from "drift", driven entirely by fixtures.
 *
 * NO DATABASE, no git repository, no network, and no Supabase credential
 * variable named anywhere in this file. All three are load-bearing:
 *
 *   * It imports only src/scripts/lib/migrationGapClassification.ts and
 *     src/scripts/lib/mainBranchFiles.ts, both guard-free.
 *     src/scripts/auditMigrationsVsLive.ts — the I/O shell — imports
 *     src/lib/ciProdReadOnlyAuditGuard.mjs as its FIRST import, and that guard
 *     calls process.exit(2) when it cannot establish the target. A test that
 *     imported the shell would die at import under the loopback target
 *     `pnpm run test` pins. Same split, same reason, as migrationLedger.test.ts.
 *   * scripts/check-guard-coverage.mjs classifies any file under src/ that
 *     NAMES a Supabase credential env var as able to reach Supabase.
 *
 * THESE ARE THE FUNCTIONS THE SCRIPT CALLS. The last section proves it, by
 * reading auditMigrationsVsLive.ts as text: a test of a helper the script never
 * calls proves nothing about the script, and that mistake was made twice in
 * this repo on 2026-09-06 alone.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyGap,
  classifyGaps,
  decideGapExitCode,
  formatGapReport,
  gapsIn,
  type ClassifiedGap,
  type MigrationGap,
} from "../scripts/lib/migrationGapClassification.js";
import {
  DEFAULT_MAIN_REF,
  resolveMainFileSet,
  type GitRunResult,
  type GitRunner,
} from "../scripts/lib/mainBranchFiles.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dir, "../scripts/auditMigrationsVsLive.ts");

const MIGRATIONS_DIR = "artifacts/api-server/src/migrations";

const gap = (file: string, over: Partial<MigrationGap> = {}): MigrationGap => ({
  file,
  repoPath: `${MIGRATIONS_DIR}/${file}`,
  missing: [`table public.${file.replace(/^\d+_|\.sql$/g, "")}`],
  ledgerTracksDir: true,
  ...over,
});

const ctx = {
  projectRef: "hwokxgbmezheskbzskfr",
  mainRefLabel: DEFAULT_MAIN_REF,
  evidenceTrail: [] as string[],
};

/** Every file on disk has a ledger row: the set of row-less files is empty. */
const ALL_RECORDED: ReadonlySet<string> = new Set<string>();

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY 1 — DRIFT. The finding the guard exists for. It must stay loud.
// ─────────────────────────────────────────────────────────────────────────────
describe("category 1 — applied per the ledger, objects absent → DRIFT", () => {
  it("classifies a recorded migration with missing objects as drift", () => {
    assert.deepEqual(classifyGap("recorded", "present"), {
      category: "drift",
      reason: "recorded-in-ledger",
    });
  });

  it("is drift regardless of whether the file is on main", () => {
    // A recorded row is proof the apply reached this database. Where the file
    // lives in the repo cannot make that less true.
    for (const main of ["present", "absent", "indeterminate"] as const) {
      assert.equal(
        classifyGap("recorded", main).category,
        "drift",
        `ledger=recorded main=${main} must be drift`,
      );
    }
  });

  it("drives the whole pipeline to exit 1 and names the file and its objects", () => {
    const classified = classifyGaps(
      [gap("2298_intel_claim_reviews.sql", { missing: ["table public.a", "index i"] })],
      { filesWithoutLedgerRow: ALL_RECORDED, mainPaths: new Set([`${MIGRATIONS_DIR}/2298_intel_claim_reviews.sql`]) },
    );
    assert.equal(classified[0].category, "drift");
    assert.equal(classified[0].ledger, "recorded");
    assert.equal(decideGapExitCode(classified), 1);

    const report = formatGapReport(classified, ctx);
    assert.match(report, /DRIFT/);
    assert.match(report, /2298_intel_claim_reviews\.sql/);
    assert.match(report, /missing table public\.a/);
    assert.match(report, /out of band/);
    // It must not be filed under the exit-0 heading.
    assert.doesNotMatch(report, /PENDING BY DESIGN/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY 2 — PENDING ON MAIN. Still a real problem: the apply runs on main.
// ─────────────────────────────────────────────────────────────────────────────
describe("category 2 — no ledger row, file IS on main → PENDING ON MAIN", () => {
  it("classifies a row-less migration that exists on main", () => {
    assert.deepEqual(classifyGap("absent", "present"), {
      category: "pending-on-main",
      reason: "no-ledger-row-and-on-main",
    });
  });

  it("exits 1 and says the apply — not the PR — is what is broken", () => {
    const file = "2305_wall_telemetry_events.sql";
    const classified = classifyGaps([gap(file)], {
      filesWithoutLedgerRow: new Set([file]),
      mainPaths: new Set([`${MIGRATIONS_DIR}/${file}`]),
    });
    assert.equal(classified[0].category, "pending-on-main");
    assert.equal(decideGapExitCode(classified), 1);

    const report = formatGapReport(classified, ctx);
    assert.match(report, /PENDING ON MAIN/);
    assert.match(report, new RegExp(file.replace(/\./g, "\\.")));
    assert.match(report, /refs\/heads\/main/);
    assert.doesNotMatch(report, /PENDING BY DESIGN/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CATEGORY 3 — NEW ON THIS BRANCH. The ONLY exit-0 path, and it must PRINT.
// ─────────────────────────────────────────────────────────────────────────────
describe("category 3 — no ledger row, file NOT on main → NEW ON BRANCH, exit 0", () => {
  it("classifies a row-less migration that main has never seen", () => {
    assert.deepEqual(classifyGap("absent", "absent"), {
      category: "new-on-branch",
      reason: "no-ledger-row-and-absent-from-main",
    });
  });

  it("exits 0 and prints the file by name as pending-by-design", () => {
    const file = "2311_intel_claim_reviews.sql";
    const classified = classifyGaps(
      [gap(file, { missing: ["table public.intel_claim_reviews", "policy p"] })],
      {
        filesWithoutLedgerRow: new Set([file]),
        // main carries the rest of the chain, but not this file.
        mainPaths: new Set([`${MIGRATIONS_DIR}/2309_passport_stamp_type_vocabulary.sql`]),
      },
    );
    assert.equal(classified[0].category, "new-on-branch");
    assert.equal(decideGapExitCode(classified), 0);

    const report = formatGapReport(classified, ctx);
    assert.match(report, /PENDING BY DESIGN/);
    assert.match(report, /2311_intel_claim_reviews\.sql/);
    assert.match(report, /missing table public\.intel_claim_reviews/);
    assert.match(report, /NOT DRIFT/);
    // Reported, never hidden, and never rendered as a failure.
    assert.doesNotMatch(report, /✖/);
  });

  it("does not rescue the run when a real finding sits beside it", () => {
    const brandNew = "2311_intel_claim_reviews.sql";
    const stale = "2305_wall_telemetry_events.sql";
    const classified = classifyGaps([gap(brandNew), gap(stale)], {
      filesWithoutLedgerRow: new Set([brandNew, stale]),
      mainPaths: new Set([`${MIGRATIONS_DIR}/${stale}`]),
    });
    assert.deepEqual(
      gapsIn(classified, "new-on-branch").map((g) => g.file),
      [brandNew],
    );
    assert.deepEqual(
      gapsIn(classified, "pending-on-main").map((g) => g.file),
      [stale],
    );
    assert.equal(decideGapExitCode(classified), 1);
  });

  it("is the ONLY exit-0 category", () => {
    // Exhaustive over the classifier's whole input space: no other pairing may
    // ever reach 0. A new escape hatch has to break this.
    for (const ledger of ["recorded", "absent", "unknown"] as const) {
      for (const main of ["present", "absent", "indeterminate"] as const) {
        const { category } = classifyGap(ledger, main);
        const exit = decideGapExitCode([
          { ...gap("x.sql"), ledger, main, category, reason: classifyGap(ledger, main).reason },
        ] as ClassifiedGap[]);
        assert.equal(
          exit === 0,
          ledger === "absent" && main === "absent",
          `ledger=${ledger} main=${main} exited ${exit}`,
        );
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FAIL CLOSED. A guard that guesses "probably new" is the defect, not the fix.
// ─────────────────────────────────────────────────────────────────────────────
describe("indeterminate evidence fails closed as category 2", () => {
  it("an unresolvable main comparison is pending-on-main, never new-on-branch", () => {
    assert.deepEqual(classifyGap("absent", "indeterminate"), {
      category: "pending-on-main",
      reason: "main-comparison-indeterminate",
    });
  });

  it("null mainPaths fails every row-less file closed and exits 1", () => {
    const file = "2311_intel_claim_reviews.sql";
    const classified = classifyGaps([gap(file)], {
      filesWithoutLedgerRow: new Set([file]),
      mainPaths: null, // the comparison could not be made
    });
    assert.equal(classified[0].main, "indeterminate");
    assert.equal(classified[0].category, "pending-on-main");
    assert.equal(decideGapExitCode(classified), 1);

    const report = formatGapReport(classified, {
      ...ctx,
      mainRefLabel: "origin/main (UNRESOLVED — no branch comparison was possible)",
    });
    assert.match(report, /could NOT be established/);
    assert.match(report, /the origin\/main comparison could not be made/);
    assert.doesNotMatch(report, /PENDING BY DESIGN/);
  });

  it("an unreadable ledger fails closed even when the file is absent from main", () => {
    // The tempting shortcut: "not on main, so it cannot have been applied".
    // Without the ledger there is no evidence some other path did not apply it,
    // and an audit that cannot establish its premise reports, never passes.
    assert.equal(classifyGap("unknown", "absent").category, "pending-on-main");
    assert.equal(classifyGap("unknown", "absent").reason, "ledger-indeterminate");

    const file = "2311_intel_claim_reviews.sql";
    const classified = classifyGaps([gap(file)], {
      filesWithoutLedgerRow: null, // ledger table absent, or the read failed
      mainPaths: new Set<string>(),
    });
    assert.equal(classified[0].ledger, "unknown");
    assert.equal(decideGapExitCode(classified), 1);
    assert.match(formatGapReport(classified, ctx), /the ledger could not be read/);
  });

  it("a directory the ledger does not track fails closed", () => {
    // --include-legacy adds the frozen chain, which has no ledger rows at all.
    const classified = classifyGaps(
      [gap("0032_user_location_preferences.sql", { ledgerTracksDir: false })],
      { filesWithoutLedgerRow: ALL_RECORDED, mainPaths: new Set<string>() },
    );
    assert.equal(classified[0].ledger, "unknown");
    assert.equal(classified[0].category, "pending-on-main");
    assert.equal(decideGapExitCode(classified), 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A CLEAN TREE. No gaps, no classification, still exit 0.
// ─────────────────────────────────────────────────────────────────────────────
describe("a clean tree still exits 0", () => {
  it("classifies nothing and exits 0", () => {
    const classified = classifyGaps([], {
      filesWithoutLedgerRow: ALL_RECORDED,
      mainPaths: new Set<string>(),
    });
    assert.deepEqual(classified, []);
    assert.equal(decideGapExitCode(classified), 0);
    const report = formatGapReport(classified, ctx);
    assert.match(report, /contains every object claimed by the migrations/);
    assert.doesNotMatch(report, /DRIFT/);
    assert.doesNotMatch(report, /PENDING/);
  });

  it("exits 0 with no gaps even when the evidence is entirely unavailable", () => {
    // Nothing missing is nothing missing. The ledger and the branch comparison
    // only ever explain a gap; with no gap there is nothing to explain, and an
    // unavailable explanation must not invent one.
    const classified = classifyGaps([], {
      filesWithoutLedgerRow: null,
      mainPaths: null,
    });
    assert.equal(decideGapExitCode(classified), 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE BRANCH COMPARISON, including the shallow clone actions/checkout@v4 gives
// us on every PR. Driven through an injected runner: no repo, no network.
// ─────────────────────────────────────────────────────────────────────────────
const ok = (stdout = ""): GitRunResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "boom"): GitRunResult => ({ status: 128, stdout: "", stderr });

/** Records every git invocation so the decision tree itself can be asserted. */
function recorder(handler: (args: readonly string[]) => GitRunResult): {
  run: GitRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    run: (args) => {
      calls.push([...args]);
      return handler(args);
    },
  };
}

describe("resolving the apply branch", () => {
  const listing = [
    `${MIGRATIONS_DIR}/2309_passport_stamp_type_vocabulary.sql`,
    `${MIGRATIONS_DIR}/2310_something.sql`,
  ].join("\n");

  it("uses origin/main directly when the checkout already has it", () => {
    const { run, calls } = recorder((args) =>
      args[0] === "rev-parse" ? ok() : ok(listing),
    );
    const res = resolveMainFileSet({ run, dirs: [MIGRATIONS_DIR] });
    assert.notEqual(res.paths, null);
    assert.equal(res.paths?.size, 2);
    assert.equal(res.resolvedRef, DEFAULT_MAIN_REF);
    assert.ok(!calls.some((c) => c[0] === "fetch"), "must not fetch when the ref is present");
  });

  it("fetches at depth 1 when origin/main is missing — the shallow PR checkout", () => {
    let fetched = false;
    const { run, calls } = recorder((args) => {
      if (args[0] === "fetch") {
        fetched = true;
        return ok();
      }
      if (args[0] === "rev-parse") return fetched ? ok() : fail("unknown revision");
      return ok(listing);
    });
    const res = resolveMainFileSet({ run, dirs: [MIGRATIONS_DIR] });
    assert.equal(res.resolvedRef, DEFAULT_MAIN_REF);
    assert.equal(res.paths?.size, 2);
    const fetchCall = calls.find((c) => c[0] === "fetch");
    assert.ok(fetchCall, "a missing origin/main must trigger a fetch");
    assert.ok(fetchCall.includes("--depth=1"), "the fetch must stay shallow");
    assert.ok(
      fetchCall.includes("+refs/heads/main:refs/remotes/origin/main"),
      "an explicit refspec, so the tracking ref is written whatever remote.origin.fetch says",
    );
    assert.match(res.detail.join("\n"), /fetched refs\/heads\/main/);
  });

  it("falls back to FETCH_HEAD when the fetch lands but the tracking ref does not", () => {
    const { run } = recorder((args) => {
      if (args[0] === "fetch") return ok();
      if (args[0] === "rev-parse") {
        return args.some((a) => a.startsWith("FETCH_HEAD")) ? ok() : fail();
      }
      return ok(listing);
    });
    const res = resolveMainFileSet({ run, dirs: [MIGRATIONS_DIR] });
    assert.equal(res.resolvedRef, "FETCH_HEAD");
    assert.equal(res.paths?.size, 2);
    assert.match(res.label, /via FETCH_HEAD/);
  });

  it("is INDETERMINATE — never an empty set — when the fetch fails", () => {
    const { run } = recorder((args) =>
      args[0] === "ls-tree" ? ok(listing) : fail("could not read from remote"),
    );
    const res = resolveMainFileSet({ run, dirs: [MIGRATIONS_DIR] });
    assert.equal(res.paths, null, "an empty set would classify everything as new-on-branch");
    assert.equal(res.resolvedRef, null);
    assert.match(res.label, /UNRESOLVED/);
    assert.match(res.detail.join("\n"), /INDETERMINATE/);
  });

  it("discards the whole comparison when any ls-tree fails", () => {
    const { run } = recorder((args) => {
      if (args[0] === "rev-parse") return ok();
      if (args[0] === "ls-tree") return args.includes("legacy/") ? fail() : ok(listing);
      return ok();
    });
    const res = resolveMainFileSet({ run, dirs: [MIGRATIONS_DIR, "legacy/"] });
    assert.equal(res.paths, null, "a partial listing reports files as absent that were merely not listed");
  });

  it("treats a git that cannot be spawned as indeterminate, not as an error", () => {
    const { run } = recorder(() => ({ status: -1, stdout: "", stderr: "ENOENT" }));
    const res = resolveMainFileSet({ run, dirs: [MIGRATIONS_DIR] });
    assert.equal(res.paths, null);
  });

  it("honours an explicit ref and skips the main-specific fetch path when told to", () => {
    const { run, calls } = recorder((args) => (args[0] === "rev-parse" ? ok() : ok(listing)));
    const res = resolveMainFileSet({
      run,
      dirs: [MIGRATIONS_DIR],
      ref: "upstream/release",
      allowFetch: false,
    });
    assert.equal(res.resolvedRef, "upstream/release");
    assert.ok(
      calls.some((c) => c[0] === "rev-parse" && c.includes("upstream/release^{commit}")),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THE SHIPPED SCRIPT CALLS THESE FUNCTIONS.
//
// A classifier the entry point never reaches is a classifier that classifies
// nothing. Read as text rather than imported, because importing
// auditMigrationsVsLive.ts runs src/lib/ciProdReadOnlyAuditGuard.mjs and exits.
// ─────────────────────────────────────────────────────────────────────────────
describe("auditMigrationsVsLive.ts actually uses this classifier", () => {
  const source = readFileSync(SCRIPT, "utf8");

  it("imports the classifier and the branch resolver", () => {
    assert.match(source, /from "\.\/lib\/migrationGapClassification\.js"/);
    assert.match(source, /from "\.\/lib\/mainBranchFiles\.js"/);
  });

  it("calls each of them, and exits on decideGapExitCode", () => {
    for (const fn of [
      "classifyGaps(",
      "formatGapReport(",
      "decideGapExitCode(",
      "resolveMainFileSet(",
    ]) {
      assert.ok(source.includes(fn), `auditMigrationsVsLive.ts must call ${fn}`);
    }
    assert.match(source, /process\.exit\(exitCode\)/);
  });

  it("reads the ledger through the shared core rather than a second definition", () => {
    assert.match(source, /from "\.\/lib\/migrationLedgerCore\.js"/);
    assert.ok(source.includes("computeLedgerDrift("));
    assert.ok(source.includes("LEDGER_TABLE"));
  });

  it("keeps no filename allowlist for the pending-by-design category", () => {
    // The one shortcut that would recreate the defect: a hardcoded list of
    // "expected" migrations. Membership in category 3 is re-derived every run
    // from the ledger and from origin/main, or it is not category 3.
    for (const rel of [
      "../scripts/lib/migrationGapClassification.ts",
      "../scripts/lib/mainBranchFiles.ts",
    ]) {
      const code = readFileSync(resolve(__dir, rel), "utf8")
        // Prose may name a migration (the defect's own example does). Executable
        // code may not: strip comments, then look at what is left.
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      assert.doesNotMatch(code, /\.sql/, `${rel} must not name a migration file in code`);
    }
  });
});
