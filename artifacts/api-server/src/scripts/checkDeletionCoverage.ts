/**
 * check:deletion-coverage — every user-keyed table has a stated deletion fate.
 *
 * Plain Node + the committed baseline. No database, no network, no credentials:
 * it reads baseline/20260819_baseline_structure.sql, finds every table carrying
 * a user-identifying column, and asserts each appears in exactly one bucket of
 * src/lib/deletionDispositions.ts.
 *
 * WHAT IT ENFORCES: that a NEW user-keyed table cannot be added without someone
 * writing down what happens to it when a user deletes their account.
 *
 * WHAT IT DOES NOT ENFORCE — stated rather than implied:
 *   * that UNCLASSIFIED_BACKLOG entries are safe. They are not. Being on that
 *     list means the data survives deletion and nobody has decided whether it
 *     should. The count is printed on every run so the debt stays visible.
 *   * that ERASED_BY_CASCADE entries are actually erased. This checks the
 *     manifest against the schema, not against the service's behaviour.
 *   * post-baseline tables. The baseline is the 2026-08-19 snapshot; tables
 *     created after cutover (the journey_* family is live on production and
 *     absent here) are invisible to this check until the baseline is recaptured.
 *     That is the same blind spot rlsDispositions has, and it is why recapture
 *     is part of the apply sequence rather than an afterthought.
 *
 * Exit 0 only if every baseline user-keyed table is classified exactly once.
 */
import { readFileSync } from "node:fs";
import { BASELINE_PATH } from "./parseBaselineSchema.js";
import {
  ERASED_BY_CASCADE,
  ANONYMISED_FK_NULLED,
  DELETION_FLOW_TABLES,
  RETAINED_WITH_REASON,
  UNCLASSIFIED_BACKLOG,
  POST_BASELINE_TABLES,
  USER_IDENTIFYING_COLUMNS,
} from "../lib/deletionDispositions.js";

/** Tables in the baseline carrying at least one user-identifying column. */
export function userKeyedTablesFromBaseline(sql: string): Map<string, string[]> {
  const userCols = new Set(USER_IDENTIFYING_COLUMNS);
  const out = new Map<string, string[]>();
  const blocks = sql.matchAll(/^CREATE TABLE public\.([A-Za-z0-9_]+) \(([\s\S]*?)^\);/gm);
  for (const m of blocks) {
    const [, name, body] = m;
    const cols = new Set<string>();
    for (const c of body.matchAll(/^\s+([a-z_][a-z0-9_]*)\s+/gm)) cols.add(c[1]);
    const hit = [...cols].filter((c) => userCols.has(c)).sort();
    if (hit.length > 0) out.set(name, hit);
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

  for (const [t] of tables) {
    const buckets = [
      erased.has(t) && "ERASED_BY_CASCADE",
      nulled.has(t) && "ANONYMISED_FK_NULLED",
      flow.has(t) && "DELETION_FLOW_TABLES",
      retained.has(t) && "RETAINED_WITH_REASON",
      backlog.has(t) && "UNCLASSIFIED_BACKLOG",
    ].filter(Boolean) as string[];

    if (buckets.length === 0) {
      problems.push({
        kind: "UNCLASSIFIED NEW TABLE",
        table: t,
        detail:
          `carries a user-identifying column but appears in no bucket of deletionDispositions.ts. ` +
          `Decide what happens to it on account deletion: add it to ERASED_BY_CASCADE (and clear it in ` +
          `AccountDeletionService), or to RETAINED_WITH_REASON with a reason a user could be shown. ` +
          `Do NOT add it to UNCLASSIFIED_BACKLOG — that list is a dated record of pre-existing debt, not a place to put new tables.`,
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
  ]) {
    const postBaseline = new Set(POST_BASELINE_TABLES);
    for (const t of list.items) {
      // Post-baseline tables are classified but not yet in the snapshot; they
      // stop being exempt once the baseline is recaptured.
      if (!tables.has(t) && !postBaseline.has(t)) {
        problems.push({
          kind: "STALE ENTRY",
          table: t,
          detail: `listed in ${list.name} but is not a user-keyed table in the baseline. Remove it.`,
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

function main(): void {
  const tables = userKeyedTablesFromBaseline(readFileSync(BASELINE_PATH, "utf8"));
  if (tables.size === 0) {
    console.error("✖ check-deletion-coverage: zero user-keyed tables parsed — the scan has no subject.");
    process.exit(1);
  }
  const problems = computeProblems(tables);

  console.log(
    `\ncheck-deletion-coverage: ${tables.size} user-keyed table(s) in the baseline\n` +
      `   ${ERASED_BY_CASCADE.length} erased by the cascade\n` +
      `   ${ANONYMISED_FK_NULLED.length} anonymised in place (FK identifier NULLed, row kept)\n` +
      `   ${DELETION_FLOW_TABLES.length} deletion-flow tables (not user content)\n` +
      `   ${RETAINED_WITH_REASON.length} retained with a written reason\n` +
      `   ${UNCLASSIFIED_BACKLOG.length} UNCLASSIFIED — survive deletion, undecided (owner decision D6)\n`,
  );

  if (problems.length > 0) {
    console.error(`✖ check-deletion-coverage FAILED — ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  • ${p.kind}: "${p.table}" ${p.detail}`);
    process.exit(1);
  }
  console.log("✓ every user-keyed table in the baseline has a stated deletion fate.\n");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
