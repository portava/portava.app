/**
 * `services/trust/` owns every read of the Trust tables — `check:trust-table-ownership`.
 *
 * ── THE RULE, AND WHOSE IT IS ────────────────────────────────────────────────
 *
 * Two docblocks in the tree already state it. `TrustRestrictionService.ts:178`:
 * *"Used by enforcement seams in other routes — always call this, never query
 * trust_restrictions directly in route code."* `TrustScoreService.ts:353`:
 * `getDisplayTrustScore` is *"the single source every Passport surface must
 * read so the owner Home identity card, TrustScreen and the Rent-a-Buddy card
 * can never disagree"*.
 *
 * Both were violated, and census-trust measured it: **eleven** direct
 * `trust_profiles` / `trust_caps` reads outside `services/trust` (A17) and one
 * direct `trust_restrictions` read in an admin route (C15). A rule nothing
 * enforces is a comment.
 *
 * ── WHY THE VIOLATIONS EXISTED, WHICH IS THE INTERESTING PART ────────────────
 *
 * Not laziness. Three of them could not comply with the API the service offered:
 *
 *   - three LIST paths needed many users at once, and the canonical helper was
 *     per-user, so obeying meant N round trips on a feed;
 *   - an admin dossier needed the restriction ROW — id, reason, created_at —
 *     and the enforcement seam answers in booleans;
 *   - a boost GATE needed to fail closed on an unreadable caps table, and
 *     `getActiveCaps` returns `[]` on failure, which a gate cannot tell from
 *     "no caps".
 *
 * So the seam was widened — `getDisplayTrustScores`, `listRestrictionsForAudit`,
 * `getActiveCapsResult` — rather than the rule being waived. This checker exists
 * so the next caller with a shape the service does not cover widens it too,
 * instead of reaching past it silently.
 *
 * ── WHAT IT DOES NOT COVER, STATED RATHER THAN IMPLIED ───────────────────────
 *
 *   1. A dynamic table name: `.from(someVariable)` is invisible to it. It scans
 *      for the literal, which is a FLOOR on the violations, never a ceiling.
 *   2. Whether a call through the seam USES the answer correctly. It checks who
 *      may read the table, not what they conclude.
 *   3. Writes. Nothing here says only Trust may write these tables.
 *   4. The mobile client, which reaches Trust over HTTP and cannot name a table.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");

/** The tables `services/trust/` owns. */
const TRUST_TABLES = ["trust_profiles", "trust_caps", "trust_restrictions"] as const;

/**
 * Files outside `services/trust/` that may still name a Trust table, each with
 * the reason. An entry is a decision, not a suppression, and every one is
 * validated: a path that names no Trust table FAILS, so this list can only
 * shrink as the tree changes.
 */
const OWNED_ELSEWHERE: Record<string, string> = {
  "lib/trustMaintenanceScheduler.ts":
    "IS the Trust engine's maintenance job — it recalculates scores, expires restrictions and sweeps " +
    "decay. It is Trust-owned code sitting in lib/ for historical reasons, not another surface reaching " +
    "in. Routing bulk maintenance scans through a per-user read seam would be slower and would hide " +
    "that they are scans.",
  "routes/trust-admin.ts":
    "The Trust ADMIN surface. Its restriction read goes through listRestrictionsForAudit; the one " +
    "remaining direct read enumerates user_ids for the recalculation sweep, where a seam would exist " +
    "for exactly one caller and would obscure that the loop is capped at 1000.",
  "lib/stateMachines/registry.ts":
    "Names the tables inside EVIDENCE STRINGS that document which file writes which state machine. A " +
    "string is not a read; the registry issues no query at all.",
  // routes/admin.ts is NOT here, and that is this checker catching me. I added
  // it on the grounds that the file "names trust_restrictions in a comment" —
  // and the staleness rule below rejected the entry, correctly: comments are
  // stripped before the scan, so the file names no Trust table at all and needs
  // no exemption. An allowlist entry for a file that does not need one is
  // exactly how such a list stops being read.
};

const SKIP_DIRS = new Set(["node_modules", "migrations", "scripts", "test", "__tests__"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Blank `//` and `/* *\/` comments so a rule quoted in prose is not a read. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

const problems: string[] = [];
const files = walk(SRC);
let scanned = 0;
let readsInService = 0;
const violations: Array<{ file: string; table: string; line: number }> = [];
const seenOwnedElsewhere = new Set<string>();

for (const abs of files) {
  const rel = relative(SRC, abs).replace(/\\/g, "/");
  scanned++;
  const raw = readFileSync(abs, "utf8");
  const code = stripComments(raw);
  const hits: Array<{ table: string; line: number }> = [];
  for (const table of TRUST_TABLES) {
    const re = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]`, "g");
    for (const m of code.matchAll(re)) {
      hits.push({ table, line: code.slice(0, m.index).split("\n").length });
    }
  }
  if (hits.length === 0) continue;
  if (rel.startsWith("services/trust/")) { readsInService += hits.length; continue; }
  if (rel in OWNED_ELSEWHERE) { seenOwnedElsewhere.add(rel); continue; }
  for (const h of hits) violations.push({ file: rel, table: h.table, line: h.line });
}

for (const { file, table, line } of violations) {
  problems.push(
    `::error::${file}:${line} reads public.${table} directly. ` +
      `services/trust owns that table: use getDisplayTrustScore / getDisplayTrustScores (a score), ` +
      `getTrustProfileResult (the three-state profile), listRestrictionsForAudit (restriction rows) or ` +
      `getActiveCapsResult (caps, fail-closed). If none of them answers your question, WIDEN THE SEAM — ` +
      `that is what closing census-trust A17 did — or add this file to OWNED_ELSEWHERE with a reason.`,
  );
}

// An allowlist entry that no longer describes anything is a claim nobody checks.
for (const rel of Object.keys(OWNED_ELSEWHERE)) {
  if (!seenOwnedElsewhere.has(rel)) {
    problems.push(
      `::error::OWNED_ELSEWHERE names ${rel}, which names no Trust table any more. Delete the entry — ` +
        `an exemption for a file that does not need one is how this list stops being read.`,
    );
  }
  if ((OWNED_ELSEWHERE[rel] ?? "").length < 80) {
    problems.push(`::error::OWNED_ELSEWHERE entry for ${rel} carries a ${(OWNED_ELSEWHERE[rel] ?? "").length}-character reason. That is a label, not a reason.`);
  }
}

// Vacuity: if the service itself reads none of its tables, this checker is
// scanning the wrong tree and its green means nothing.
if (readsInService === 0) {
  problems.push(
    `::error::services/trust/ contains ZERO reads of ${TRUST_TABLES.join(" / ")}. This check found no Trust ` +
      `engine to own them, so its verdict is vacuous rather than clean.`,
  );
}

for (const p of problems) console.error(p);
console.log(
  `check:trust-table-ownership — ${scanned} source file(s) scanned; ${readsInService} read(s) inside ` +
    `services/trust; ${seenOwnedElsewhere.size} file(s) owned elsewhere with a written reason; ` +
    `${violations.length} violation(s).`,
);
console.log(
  "NOTE: DOES NOT COVER — (1) a dynamic `.from(variable)`, so this count is a FLOOR on the violations, " +
    "never a ceiling; (2) whether a caller uses the seam's answer correctly; (3) writes; (4) the mobile " +
    "client, which reaches Trust over HTTP and cannot name a table.",
);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s) found.`);
  process.exit(1);
}
console.log("\n✅ every read of a Trust table is inside services/trust or has a written owner.");
