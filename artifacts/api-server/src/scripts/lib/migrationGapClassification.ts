/**
 * Migration-gap classification — PURE, and deliberately guard-free.
 *
 *
 * THE DEFECT THIS IS WRITTEN AGAINST (2026-09-06)
 * ===============================================
 * `audit:schema` (src/scripts/auditMigrationsVsLive.ts) asks one question:
 * "does the live schema contain every object the migration files claim?" Its
 * own comment in .github/workflows/live-db.yml states the precondition:
 *
 *     "These run AFTER the apply above, in the same job, on purpose: they ask
 *      whether the live schema matches the migrations, and the apply is what
 *      makes that true."
 *
 * The apply step is gated `github.ref == 'refs/heads/main'`. The audit is NOT.
 * So on every PR branch the audit runs with its enabling step skipped, and any
 * PR that adds an object-creating migration is GUARANTEED red — observed on
 * #456, #457, #461 and #470 on 2026-09-06. The output was undifferentiated:
 *
 *     ✖ 2311_intel_claim_reviews.sql
 *     ✖ 4 missing object(s) across 1 file(s). Apply the migrations …
 *
 * Nothing there says whether that file is new on this branch or has been
 * sitting unapplied on main for a week. Those are different facts with
 * different owners, and rendering them identically is what destroys the signal:
 * once expected-red and genuine-drift look the same, a reviewer waves both
 * through, and real drift introduced by a PR sails past.
 *
 * "Not yet applied" is not "drift", exactly as "the read failed" is not "there
 * is no data".
 *
 *
 * THE THREE CATEGORIES
 * ====================
 *   1. DRIFT              — the ledger records this migration against this
 *                           database, yet its objects are absent. Something
 *                           changed the database out of band. Exit 1. This is
 *                           the finding the guard exists for; it stays loud.
 *   2. PENDING ON MAIN    — no ledger row, and the file IS on origin/main. The
 *                           apply step runs on main, so it should already have
 *                           been applied: the apply is broken or was skipped.
 *                           Exit 1.
 *   3. NEW ON THIS BRANCH — no ledger row, and the file is NOT on origin/main.
 *                           Its apply is gated to main by design and has not
 *                           happened yet. Not drift. Exit 0 — and it PRINTS,
 *                           by name, so a reader sees it was classified rather
 *                           than hidden.
 *
 * Category 3 is the ONLY exit-0 path, and every input that cannot be
 * established lands in category 2 instead. A guard that guesses "probably new"
 * whenever it cannot check is the defect this removes, not a lighter version of
 * it. There is no allowlist of filenames here and there must never be one:
 * membership in category 3 is a fact about the ledger and about origin/main,
 * re-derived on every run, never a name someone wrote down.
 *
 *
 * WHY THIS FILE IS SEPARATE, AND PURE
 * ===================================
 * Same split, for the same reason, as src/scripts/lib/migrationLedgerCore.ts
 * beside src/scripts/checkMigrationLedger.ts: the I/O shell
 * (auditMigrationsVsLive.ts) imports src/lib/ciProdReadOnlyAuditGuard.mjs as
 * its FIRST import, and that guard calls process.exit(2) when it cannot
 * establish the target. A unit test that imported the shell would die at import
 * under the loopback target `pnpm run test` pins. Everything here is a function
 * of its arguments: no database, no filesystem, no child process, and no
 * Supabase credential variable named anywhere — the last of which is what keeps
 * scripts/check-guard-coverage.mjs from classifying this file as able to reach
 * Supabase.
 *
 * The shell CALLS these functions. A classifier the script does not call would
 * prove nothing about the script.
 */

/** Whether the ledger has a row for this migration file. */
export type LedgerPresence =
  /** A row exists: this database is recorded as having run the file. */
  | "recorded"
  /** No row: this database has never recorded running the file. */
  | "absent"
  /**
   * Could not be established — the ledger table is missing, the read failed, or
   * the ledger does not track the directory the file lives in. Fails closed.
   */
  | "unknown";

/** Whether the migration file exists on the branch the apply step runs on. */
export type MainPresence =
  | "present"
  | "absent"
  /** The comparison could not be made. Fails closed; never "probably new". */
  | "indeterminate";

export type GapCategory = "drift" | "pending-on-main" | "new-on-branch";

/** Why a gap landed in its category. Rendered verbatim in the report. */
export type GapReason =
  /** The ledger records the apply; the objects are gone anyway. */
  | "recorded-in-ledger"
  /** No ledger row, and the file is on the apply branch. */
  | "no-ledger-row-and-on-main"
  /** No ledger row, and the file is NOT on the apply branch. The only exit-0. */
  | "no-ledger-row-and-absent-from-main"
  /** No ledger row, and the branch comparison could not be made. Fail closed. */
  | "main-comparison-indeterminate"
  /** The ledger itself could not be read. Fail closed. */
  | "ledger-indeterminate";

export interface GapClassification {
  category: GapCategory;
  reason: GapReason;
}

/**
 * The classification rule, in one place.
 *
 * ORDER MATTERS AND IS DELIBERATE. The ledger is consulted first and an
 * unreadable ledger short-circuits to category 2 even when the file is absent
 * from main. A file absent from main almost certainly IS new — but "almost
 * certainly" is the reasoning that produced the defect. With no ledger there is
 * no evidence that some other path did not apply it, and an audit that cannot
 * establish its premise reports a problem, not a pass.
 */
export function classifyGap(
  ledger: LedgerPresence,
  main: MainPresence,
): GapClassification {
  if (ledger === "unknown") {
    return { category: "pending-on-main", reason: "ledger-indeterminate" };
  }
  if (ledger === "recorded") {
    return { category: "drift", reason: "recorded-in-ledger" };
  }
  // ledger === "absent" — this database has no record of ever running it.
  if (main === "indeterminate") {
    return { category: "pending-on-main", reason: "main-comparison-indeterminate" };
  }
  if (main === "present") {
    return { category: "pending-on-main", reason: "no-ledger-row-and-on-main" };
  }
  return {
    category: "new-on-branch",
    reason: "no-ledger-row-and-absent-from-main",
  };
}

/** One migration file that claims objects the live schema does not have. */
export interface MigrationGap {
  /** Bare filename, e.g. "2311_intel_claim_reviews.sql". */
  file: string;
  /** Repo-relative path, as `git ls-tree` prints it. */
  repoPath: string;
  /** Human-readable labels of the absent objects, in parse order. */
  missing: string[];
  /**
   * False for migration directories the ledger does not cover (the frozen
   * legacy chain, reachable only via --include-legacy). Their ledger presence
   * cannot be established, so they fail closed rather than being waved through.
   */
  ledgerTracksDir: boolean;
}

export interface ClassifiedGap extends MigrationGap {
  ledger: LedgerPresence;
  main: MainPresence;
  category: GapCategory;
  reason: GapReason;
}

export interface GapEvidence {
  /**
   * Files on disk that have NO ledger row — `computeLedgerDrift().
   * missingFromLedger`, not a second definition of "recorded". `null` means the
   * ledger could not be read at all.
   */
  filesWithoutLedgerRow: ReadonlySet<string> | null;
  /**
   * Repo-relative paths present on the apply branch. `null` means the
   * comparison could not be made and every no-row file fails closed.
   */
  mainPaths: ReadonlySet<string> | null;
}

/** Map raw evidence onto each gap and classify it. */
export function classifyGaps(
  gaps: readonly MigrationGap[],
  evidence: GapEvidence,
): ClassifiedGap[] {
  return gaps.map((gap) => {
    const ledger: LedgerPresence =
      !gap.ledgerTracksDir || evidence.filesWithoutLedgerRow === null
        ? "unknown"
        : evidence.filesWithoutLedgerRow.has(gap.file)
          ? "absent"
          : "recorded";
    const main: MainPresence =
      evidence.mainPaths === null
        ? "indeterminate"
        : evidence.mainPaths.has(gap.repoPath)
          ? "present"
          : "absent";
    return { ...gap, ledger, main, ...classifyGap(ledger, main) };
  });
}

/**
 * 0 only when every gap is category 3.
 *
 * 2 stays reserved for "cannot run" and is decided by the shell — the same
 * 0/1/2 contract checkMigrationLedger.ts and checkMissingLiveColumns.ts print
 * in their own headers.
 */
export function decideGapExitCode(gaps: readonly ClassifiedGap[]): 0 | 1 {
  return gaps.some((g) => g.category !== "new-on-branch") ? 1 : 0;
}

export function gapsIn(
  gaps: readonly ClassifiedGap[],
  category: GapCategory,
): ClassifiedGap[] {
  return gaps.filter((g) => g.category === category);
}

export interface GapReportContext {
  /** The Supabase project ref the live schema and ledger were read from. */
  projectRef: string;
  /** The ref the branch comparison used, or a sentence saying why there is none. */
  mainRefLabel: string;
  /** One line per step of the ledger read and the branch resolution. */
  evidenceTrail: readonly string[];
}

const plural = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;

function renderGap(gap: ClassifiedGap, out: string[]): void {
  out.push(`      ${gap.file}`);
  for (const label of gap.missing) out.push(`          missing ${label}`);
}

/**
 * The message a person reads once and knows whose problem it is.
 *
 * Every category prints, including the one that exits 0. A finding that is
 * classified as expected and then hidden teaches the same lesson as a finding
 * that is misclassified as drift: that the guard's output is not worth reading.
 */
export function formatGapReport(
  gaps: readonly ClassifiedGap[],
  ctx: GapReportContext,
): string {
  const out: string[] = [];
  const drift = gapsIn(gaps, "drift");
  const pending = gapsIn(gaps, "pending-on-main");
  const byDesign = gapsIn(gaps, "new-on-branch");

  out.push("");
  out.push(
    `── Migration gaps, classified against public.schema_migration_ledger on ` +
      `${ctx.projectRef}\n   and ${ctx.mainRefLabel}`,
  );
  for (const line of ctx.evidenceTrail) out.push(`   · ${line}`);

  if (gaps.length === 0) {
    out.push("");
    out.push(
      "✔ Live schema contains every object claimed by the migrations. No gaps to classify.",
    );
    return out.join("\n");
  }

  if (drift.length > 0) {
    out.push("");
    out.push(
      `  ✖ DRIFT — ${drift.length} ${plural(drift.length, "file", "files")} the ledger ` +
        `records as APPLIED to ${ctx.projectRef}, whose objects are absent:`,
    );
    for (const gap of drift) renderGap(gap, out);
    out.push(
      "\n    This is the finding this audit exists for. The database ran these files and\n" +
        "    the objects are not there: something changed this database out of band. Do not\n" +
        "    re-apply blindly — find out what removed them first.",
    );
  }

  if (pending.length > 0) {
    const indeterminate = pending.filter(
      (g) => g.reason !== "no-ledger-row-and-on-main",
    );
    out.push("");
    out.push(
      `  ✖ PENDING ON MAIN — ${pending.length} ${plural(pending.length, "file", "files")} ` +
        `with no ledger row that SHOULD already be applied:`,
    );
    for (const gap of pending) renderGap(gap, out);
    out.push(
      "\n    `migrations — apply to the sanctioned CI project` runs on refs/heads/main, and\n" +
        "    these files are on main. The apply is broken, was skipped, or never reached\n" +
        "    them. Fix the apply — this is not something a PR branch caused.",
    );
    if (indeterminate.length > 0) {
      out.push("");
      out.push(
        `    ${indeterminate.length} of those ${plural(indeterminate.length, "is", "are")} here ` +
          "because the evidence could NOT be established, not because it was\n" +
          "    established against them. FAILING CLOSED is deliberate: a guard that assumes\n" +
          '    "probably new" whenever it cannot check is the exact defect this classifier\n' +
          "    removes. Restore the evidence and re-run:",
      );
      for (const gap of indeterminate) {
        out.push(
          `      ${gap.file}   (${
            gap.reason === "ledger-indeterminate"
              ? "the ledger could not be read"
              : "the origin/main comparison could not be made"
          })`,
        );
      }
    }
  }

  if (byDesign.length > 0) {
    out.push("");
    out.push(
      `  • PENDING BY DESIGN — ${byDesign.length} ${plural(byDesign.length, "file", "files")} ` +
        `new on this branch and absent from ${ctx.mainRefLabel}:`,
    );
    for (const gap of byDesign) renderGap(gap, out);
    out.push(
      "\n    NOT DRIFT, and not a failure. The apply step in .github/workflows/live-db.yml\n" +
        "    is gated to refs/heads/main by design, so these cannot have been applied yet;\n" +
        "    they will be applied when this branch merges. Listed by name because a gap\n" +
        "    that is considered and dismissed must still be visible — the classification is\n" +
        "    the point, not the silence.",
    );
  }

  out.push("");
  const failing = drift.length + pending.length;
  if (failing > 0) {
    out.push(
      `✖ ${failing} migration ${plural(failing, "file", "files")} with unexplained missing ` +
        `objects (${drift.length} drift, ${pending.length} pending on main); ` +
        `${byDesign.length} pending by design.`,
    );
    out.push(
      "  Apply the migrations via the Supabase Management API and update docs/migrations.md.",
    );
  } else {
    out.push(
      `✔ No drift. ${byDesign.length} migration ${plural(byDesign.length, "file", "files")} ` +
        "on this branch cannot be applied until it merges, which is by design.",
    );
  }
  out.push("");

  return out.join("\n");
}
