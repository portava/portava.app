/**
 * check:deletion-coverage — every user-LINKED table has a stated deletion fate.
 *
 * Plain Node + the committed baseline. No database, no network, no credentials:
 * it reads baseline/20260819_baseline_structure.sql, derives which tables are
 * linked to a user account, and asserts each appears in exactly one bucket of
 * src/lib/deletionDispositions.ts.
 *
 * ── THE DENOMINATOR IS MEASURED, NOT GUESSED (corrected 2026-09-08) ──────────
 * This gate used to answer "is this table about a user?" by matching 18
 * recognised COLUMN NAMES. A column name is a convention, not a fact: a table
 * can carry a person's uuid behind a FOREIGN KEY to profiles/auth.users and
 * carry no recognised name at all. So the gate reported 248 user-keyed tables
 * while the schema declares 366, and 91 tables — `blocks`, `appeals`,
 * `moderation_actions`, `reviews`, `media_assets`, `user_restrictions`,
 * `user_mutes`, `safe_return_contacts`, `trip_documents` and `profiles` itself
 * among them — sat outside the universe a legal-surface guard is supposed to
 * govern. Worse, tables the deletion service ALREADY erases could not be
 * recorded as erased: an entry the name list could not see was reported as a
 * STALE ENTRY, so the manifest was pushed to under-state real behaviour.
 *
 * The universe now comes from src/lib/deletion/userLink.ts, which walks the
 * foreign-key graph of the dump. Column names still contribute — they are the
 * only evidence for a uuid no constraint backs — but they are never the sole
 * source of truth. Every table gets a STATED REASON, printable with --json.
 *
 * WHAT IT ENFORCES: that a NEW user-linked table cannot be added without
 * someone writing down what happens to it when a user deletes their account.
 *
 * WHAT IT DOES NOT ENFORCE — stated rather than implied:
 *   * that UNCLASSIFIED_BACKLOG / DENOMINATOR_CORRECTION_BACKLOG entries are
 *     safe. They are not. Being on those lists means the data survives deletion
 *     and nobody has decided whether it should. Both counts are printed on
 *     every run so the debt stays visible.
 *   * that ERASED_BY_CASCADE entries are actually erased. This checks the
 *     manifest against the schema, not against the service's behaviour.
 *   * post-baseline tables. The baseline is the 2026-08-19 snapshot; tables
 *     created after cutover (the journey_* family is live on production and
 *     absent here) are invisible to this check until the baseline is recaptured.
 *     That is the same blind spot rlsDispositions has, and it is why recapture
 *     is part of the apply sequence rather than an afterthought.
 *   * a user's uuid in a `text` column or inside jsonb. The foreign-key graph
 *     cannot see it and neither can the name rules. AMBIGUOUS is where the
 *     schema's inability to tell is made visible instead of assumed away.
 *
 * Exit 0 only if every user-linked table is classified exactly once.
 *
 *   node --import tsx/esm src/scripts/checkDeletionCoverage.ts
 *   node --import tsx/esm src/scripts/checkDeletionCoverage.ts --json
 */
import { readFileSync } from "node:fs";
import { BASELINE_PATH } from "./parseBaselineSchema.js";
import { classifyUserLinks, userLinkCounts } from "../lib/deletion/userLink.js";
import type { UserLinkFact } from "../lib/deletion/types.js";
import {
  ERASED_BY_CASCADE,
  ANONYMISED_FK_NULLED,
  DELETION_FLOW_TABLES,
  RETAINED_WITH_REASON,
  UNCLASSIFIED_BACKLOG,
  DENOMINATOR_CORRECTION_BACKLOG,
  POST_BASELINE_TABLES,
} from "../lib/deletionDispositions.js";

/**
 * FLOORS. A denominator that shrinks is the failure mode this whole change
 * exists to prevent, and a silent shrink would look exactly like a pass. These
 * are the measured values on 2026-09-08; they may only be revised UPWARD, or
 * downward in a change that says in its message which tables left the schema.
 */
export const TOTAL_TABLE_FLOOR = 380;
/** The 248 the old column-name heuristic found. The measured answer is a superset. */
export const NAME_HEURISTIC_FLOOR = 248;
export const GOVERNED_FLOOR = 360;
export const DIRECT_FLOOR = 290;

/** Every table linked to a user account, with the reason it is in scope. */
export function userLinkFacts(sql: string): Map<string, UserLinkFact> {
  return classifyUserLinks({ sql, extraTables: POST_BASELINE_TABLES });
}

/**
 * The deletion denominator: table -> the reason(s) it is in scope.
 *
 * Kept as Map<string, string[]> because callers (and the coverage suite) treat
 * the value as "the evidence that put this table here". It used to be the list
 * of matching column names; it is now the stated reasons from the user-link
 * graph, which is strictly more information in the same shape.
 */
export function userKeyedTablesFromBaseline(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of userLinkFacts(sql).values()) {
    if (f.governed) out.set(f.table, f.reasons);
  }
  return out;
}

export interface CoverageProblem { kind: string; table: string; detail: string }

export function computeProblems(tables: Map<string, string[]>): CoverageProblem[] {
  const problems: CoverageProblem[] = [];
  const erased = new Set(ERASED_BY_CASCADE);
  const nulled = new Set(ANONYMISED_FK_NULLED);
  const flow = new Set(DELETION_FLOW_TABLES);
  const retained = new Set(RETAINED_WITH_REASON.map((r) => r.table));
  const backlog = new Set(UNCLASSIFIED_BACKLOG);
  const correction = new Set(DENOMINATOR_CORRECTION_BACKLOG);

  for (const [t] of tables) {
    const buckets = [
      erased.has(t) && "ERASED_BY_CASCADE",
      nulled.has(t) && "ANONYMISED_FK_NULLED",
      flow.has(t) && "DELETION_FLOW_TABLES",
      retained.has(t) && "RETAINED_WITH_REASON",
      backlog.has(t) && "UNCLASSIFIED_BACKLOG",
      correction.has(t) && "DENOMINATOR_CORRECTION_BACKLOG",
    ].filter(Boolean) as string[];

    if (buckets.length === 0) {
      problems.push({
        kind: "UNCLASSIFIED NEW TABLE",
        table: t,
        detail:
          `is linked to a user account but appears in no bucket of deletionDispositions.ts. ` +
          `Decide what happens to it on account deletion: add it to ERASED_BY_CASCADE (and clear it in ` +
          `AccountDeletionService), or to RETAINED_WITH_REASON with a reason a user could be shown. ` +
          `Do NOT add it to UNCLASSIFIED_BACKLOG — that list is a dated record of pre-existing debt, not a place to put new tables. ` +
          `Do NOT add it to DENOMINATOR_CORRECTION_BACKLOG either — that list is closed: it is the dated record of the 91 tables ` +
          `the old column-name denominator could not see, not a second hiding place.`,
      });
    } else if (buckets.length > 1) {
      problems.push({ kind: "DOUBLE-CLASSIFIED", table: t, detail: `appears in ${buckets.join(" and ")}` });
    }
  }

  // Stale entries keep the manifest honest over time.
  for (const list of [
    { name: "ERASED_BY_CASCADE", items: ERASED_BY_CASCADE },
    { name: "ANONYMISED_FK_NULLED", items: ANONYMISED_FK_NULLED },
    { name: "DELETION_FLOW_TABLES", items: DELETION_FLOW_TABLES },
    { name: "UNCLASSIFIED_BACKLOG", items: UNCLASSIFIED_BACKLOG },
    { name: "DENOMINATOR_CORRECTION_BACKLOG", items: DENOMINATOR_CORRECTION_BACKLOG },
  ]) {
    const postBaseline = new Set(POST_BASELINE_TABLES);
    for (const t of list.items) {
      // Post-baseline tables are classified but not yet in the snapshot; they
      // stop being exempt once the baseline is recaptured.
      if (!tables.has(t) && !postBaseline.has(t)) {
        problems.push({
          kind: "STALE ENTRY",
          table: t,
          detail: `listed in ${list.name} but is not a user-linked table in the baseline. Remove it.`,
        });
      }
    }
  }
  for (const r of RETAINED_WITH_REASON) {
    if (!r.reason || r.reason.trim() === "") {
      problems.push({ kind: "EMPTY REASON", table: r.table, detail: "RETAINED_WITH_REASON needs a written reason." });
    }
  }
  return problems;
}

/**
 * The six headline counts, plus the vacuity floors. Returns the problems the
 * COUNTS themselves reveal — a shrunken denominator is a failure even when
 * every table in it is classified.
 */
export function denominatorProblems(links: Map<string, UserLinkFact>): CoverageProblem[] {
  const c = userLinkCounts(links);
  const out: CoverageProblem[] = [];
  const floor = (label: string, got: number, min: number, why: string) => {
    if (got < min) out.push({ kind: "DENOMINATOR SHRANK", table: label, detail: `${got} < floor ${min} — ${why}` });
  };
  floor("TOTAL APPLICATION TABLES", c.TOTAL_APPLICATION_TABLES, TOTAL_TABLE_FLOOR,
    "the dump parsed far fewer tables than it holds, so the scan has lost its subject");
  floor("GOVERNED", c.GOVERNED, GOVERNED_FLOOR,
    "the deletion denominator has shrunk; tables have fallen out of the universe this gate governs");
  floor("DIRECT USER-LINKED", c.DIRECT_USER_LINKED, DIRECT_FLOOR,
    "the foreign-key scan is finding fewer user constraints than the schema declares");
  if (c.GOVERNED < NAME_HEURISTIC_FLOOR) {
    out.push({
      kind: "DENOMINATOR SHRANK",
      table: "GOVERNED",
      detail:
        `${c.GOVERNED} governed tables is FEWER than the ${NAME_HEURISTIC_FLOOR} the column-name heuristic ` +
        `alone used to find. The measured graph is strictly more evidence, so this can only mean it lost tables.`,
    });
  }
  return out;
}

function main(): void {
  const sql = readFileSync(BASELINE_PATH, "utf8");
  const links = userLinkFacts(sql);
  const counts = userLinkCounts(links);
  const tables = new Map([...links.values()].filter((f) => f.governed).map((f) => [f.table, f.reasons]));

  if (process.argv.includes("--json")) {
    process.stdout.write(
      JSON.stringify(
        {
          counts,
          floors: { TOTAL_TABLE_FLOOR, NAME_HEURISTIC_FLOOR, GOVERNED_FLOOR, DIRECT_FLOOR },
          tables: [...links.values()],
        },
        null,
        1,
      ) + "\n",
    );
    return;
  }

  if (tables.size === 0) {
    console.error("✖ check-deletion-coverage: zero user-linked tables derived — the scan has no subject.");
    process.exit(1);
  }

  const ambiguous = [...links.values()].filter((f) => f.linkClass === "AMBIGUOUS").map((f) => f.table);

  console.log(
    `\ncheck-deletion-coverage: the user-link graph, measured from the baseline's FOREIGN KEYS\n` +
      `   TOTAL APPLICATION TABLES ${counts.TOTAL_APPLICATION_TABLES}\n` +
      `   DIRECT USER-LINKED       ${counts.DIRECT_USER_LINKED}  (a foreign key to public.profiles / auth.users, or the user record itself)\n` +
      `   INDIRECT USER-LINKED     ${counts.INDIRECT_USER_LINKED}  (an ownership-preserving foreign key to a user-linked row)\n` +
      `   DERIVED USER-LINKED      ${counts.DERIVED_USER_LINKED}  (an unbacked user column, or a hand registration in the manifest)\n` +
      `   AMBIGUOUS                ${counts.AMBIGUOUS}  (evidence that does not settle it — IN SCOPE, because "we cannot tell" is not "no")\n` +
      `   NOT USER-LINKED          ${counts.NOT_USER_LINKED}  (no evidence of any kind; each carries a stated reason)\n` +
      `   ─────────────────────────\n` +
      `   DENOMINATOR              ${counts.GOVERNED} table(s) that must have a stated deletion fate\n` +
      `                            (the column-name heuristic this replaced found ${NAME_HEURISTIC_FLOOR})\n` +
      `\n   ${ERASED_BY_CASCADE.length} erased by the cascade\n` +
      `   ${ANONYMISED_FK_NULLED.length} anonymised in place (FK identifier NULLed, row kept)\n` +
      `   ${DELETION_FLOW_TABLES.length} deletion-flow tables (not user content)\n` +
      `   ${RETAINED_WITH_REASON.length} retained with a written reason\n` +
      `   ${UNCLASSIFIED_BACKLOG.length} UNCLASSIFIED — survive deletion, undecided (owner decision D6)\n` +
      `   ${DENOMINATOR_CORRECTION_BACKLOG.length} UNCLASSIFIED and never triaged — the tables the old denominator could not see\n` +
      `   = ${UNCLASSIFIED_BACKLOG.length + DENOMINATOR_CORRECTION_BACKLOG.length} tables whose rows survive account deletion with nobody having ruled on them\n` +
      (ambiguous.length > 0
        ? `\n   AMBIGUOUS, and therefore needing a person: ${ambiguous.join(", ")}\n`
        : "") +
      `\n   Per-table reasons: node --import tsx/esm src/scripts/checkDeletionCoverage.ts --json\n`,
  );

  const problems = [...denominatorProblems(links), ...computeProblems(tables)];
  if (problems.length > 0) {
    console.error(`✖ check-deletion-coverage FAILED — ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  • ${p.kind}: "${p.table}" ${p.detail}`);
    process.exit(1);
  }
  console.log("✓ every user-linked table in the baseline has a stated deletion fate.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
