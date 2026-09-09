/**
 * A census that cites an RLS POLICY must cite the migration that CURRENTLY
 * defines it, not the one that first created it.
 *
 * ── THE FAILURE THIS EXISTS FOR, WHICH HAPPENED TWICE IN ONE SITTING ─────────
 *
 * census-trips TR261 and TR437 both said `route_plans` is "owner-only by RLS",
 * citing `0058_trip_flow.sql:29` and concluding that a trip's crew cannot read
 * the trip's own route chain. Line 29 said exactly that. Line 32, three lines
 * later in the same file, is `route_plans_member_select`, which grants members
 * SELECT. RLS policies are a UNION — any permissive policy that passes grants
 * the row — so citing the first and stopping is not a partial reading, it is
 * an inverted one. That claim reached shipped code, as the reason string on a
 * projection layer served as `no_source`.
 *
 * The correction (census-trips §32.5) then made the SIBLING mistake in the
 * same sitting: it re-read `0058_trip_flow.sql` properly, found that the member
 * policies gate on `role IN ('owner','member')` without checking `status`, and
 * reported that as the state of the tree. It never opened
 * `2334_route_plan_crew_visibility.sql`, which DROPs and re-CREATEs all three
 * policies over `authz.is_trip_crew` — a helper that checks acceptance and
 * knows `co_host` and `viewer`. Both findings described the tree before 2334.
 *
 * ── WHAT THIS CHECKS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────
 *
 * It CANNOT check whether a census's sentence about a policy is TRUE — that is
 * a semantic claim about SQL. What it can check is the mechanical precondition
 * for that sentence being checkable by a human: if a census names a policy, and
 * that policy is created by more than one migration in the chain, then the
 * census must mention the LAST migration that creates it. Otherwise a reader
 * following the citation lands in a file describing a state that no longer
 * exists, which is exactly what happened above, twice.
 *
 * A policy created by exactly one migration is not checked: there is no later
 * definition to have missed.
 *
 * ── WHY A GUARD RATHER THAN A NOTE ──────────────────────────────────────────
 *
 * census-trips §32.7 records that this is the THIRD time in one document a
 * measurement was made on the wrong object and reported with full confidence
 * (§28's function lengths, §29.1's writers-without-readers, and this). A note
 * saying "be careful" would not have caught any of them.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { citedPolicies, judgeCitation } from "./lib/policyCitations.js";

/** Repo root, by the same reckoning checkCensusFreshness.ts uses. */
const REPO = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const CENSUS_DIR = join(REPO, "docs/architecture");
const API = join(REPO, "artifacts/api-server");
const MIGRATION_DIRS = [
  join(API, "src/migrations"),
  join(API, "migrations"),
];

/** A corpus this small is a corpus this check could not find. */
const MIN_MIGRATIONS = 100;
const MIN_CENSUSES = 5;

/** `CREATE POLICY "name"` / `CREATE POLICY name`. */
const CREATE_POLICY = /CREATE\s+POLICY\s+"?([a-z][a-z0-9_]*)"?/gi;


function readMigrations(): Map<string, string[]> {
  /** policy name -> the migration basenames that CREATE it, in chain order. */
  const creators = new Map<string, string[]>();
  let count = 0;
  const files: string[] = [];
  for (const dir of MIGRATION_DIRS) {
    let names: string[];
    try { names = readdirSync(dir); } catch { continue; }
    for (const n of names.filter((x) => x.endsWith(".sql"))) files.push(join(dir, n));
  }
  // Chain order is filename order, which is how every other check in this repo
  // replays the corpus.
  files.sort((a, b) => basename(a).localeCompare(basename(b)));
  for (const f of files) {
    count += 1;
    const sql = readFileSync(f, "utf8");
    for (const m of sql.matchAll(CREATE_POLICY)) {
      const name = m[1]!.toLowerCase();
      const list = creators.get(name) ?? [];
      const base = basename(f);
      if (list[list.length - 1] !== base) list.push(base);
      creators.set(name, list);
    }
  }
  if (count < MIN_MIGRATIONS) {
    console.error(`::error::only ${count} migration(s) found — this check did not read the corpus.`);
    process.exit(1);
  }
  return creators;
}

const creators = readMigrations();

let censusCount = 0;
let citations = 0;
let superseded = 0;
const problems: string[] = [];
const notes: string[] = [];

for (const f of readdirSync(CENSUS_DIR).filter((n) => n.startsWith("census-") && n.endsWith(".md"))) {
  censusCount += 1;
  const text = readFileSync(join(CENSUS_DIR, f), "utf8");
  for (const name of citedPolicies(text)) {
    const defs = creators.get(name);
    if (!defs || defs.length === 0) continue;   // not a policy in this corpus
    citations += 1;
    const verdict = judgeCitation(text, defs);
    if (verdict.kind === "not_applicable") continue;   // nothing later to miss
    superseded += 1;
    if (verdict.kind === "stale") {
      problems.push(
        `::error::${f} cites the policy \`${name}\`, which is re-created by ${verdict.last} ` +
        `(created by: ${verdict.chain.join(" → ")}), and never mentions ${verdict.last}. ` +
        "A reader following this citation lands in a file describing a state that no longer exists. " +
        "A schema claim is a claim about the END of the chain: grep the POLICY NAME across the whole " +
        "corpus, not the table name in the file already open. See census-trips §32.6-§32.7.",
      );
    } else {
      notes.push(`  ${f}: \`${name}\` is superseded (${defs.join(" → ")}) and ${verdict.last} IS cited.`);
    }
  }
}

if (censusCount < MIN_CENSUSES) {
  console.error(`::error::only ${censusCount} census file(s) found — this check did not read them.`);
  process.exit(1);
}

for (const p of problems) console.error(p);
if (notes.length > 0) {
  console.log("Superseded policies whose census DOES cite the current definition:");
  for (const n of notes) console.log(n);
}
console.log(
  `check:census-policy-citations — ${censusCount} census file(s), ${creators.size} policy name(s) in the ` +
  `migration corpus, ${citations} census policy citation(s) checked, ${superseded} of them to a ` +
  `SUPERSEDED policy.`,
);
console.log(
  "NOTE: DOES NOT COVER — whether a census's SENTENCE about a policy is true; that is a semantic claim " +
  "about SQL. This checks the mechanical precondition for a human being able to verify it: that the " +
  "citation points at the definition that is currently in force. It also only recognises names carrying " +
  "select/insert/update/delete/all as a `_`-delimited SEGMENT (both `foo_select` and " +
  "`trip_stages_select_crew`), because a broader pattern would sweep in tables and functions; a policy " +
  "named outside that convention is not checked.",
);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log("check:census-policy-citations PASSED");
