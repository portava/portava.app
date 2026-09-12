/**
 * check:trip-policy-callsites — Trips spec §6.1, made a ratchet.
 *
 *   "Application code calls policy functions rather than scattering host
 *    checks."
 *
 * WHAT WAS MEASURED
 * =================
 * census-trips TR102 found the rule true for plans (canEditPlan /
 * canEditPlanItem, lib/http.ts) and false everywhere else: on 2026-09-12 the
 * trip route files carried FORTY-SIX inline authorization checks of the four
 * shapes below, each a copy of a rule that lived nowhere else. lib/tripPolicy.ts
 * now holds the nine §6.1 functions; this check does two things about the
 * copies:
 *
 *   1. RATCHET. The per-file count of inline checks may only go DOWN. A file
 *      not in the baseline that carries one FAILS; a listed file whose count
 *      grew FAILS. The baseline is edited by hand when a copy is converted,
 *      exactly like tripKernelWriterBaseline.ts — a number in a file that a
 *      reviewer sees change, not a number the check silently rewrites.
 *
 *   2. REACHABILITY. Every §6.1 function must have at least one CALL SITE
 *      outside the policy module and the tests. A policy module nobody calls
 *      is the "built but not wired" case and earns nothing — the census
 *      would be reporting a function as a capability.
 *
 * THE FOUR SHAPES
 * ===============
 *   ["owner", "co_host"].includes(   the host rule, inline
 *   .role !== "owner"               the owner rule, on a membership row
 *   owner_id !== user.id            the owner rule, on the trip row
 *   owner_id === user.id            the same rule, positive form
 *
 * A route that reads `owner_id === user.id` to DECIDE SOMETHING ELSE (which
 * write path to take, whether to short-circuit a membership read) still counts
 * here. That is deliberate and slightly unfair: the shape cannot be told apart
 * from an authorization decision by text, and a ratchet that tried to would be
 * arguing about intent. The baseline absorbs the existing ones; new ones are
 * asked to go through the policy module or be written another way.
 *
 * WHAT IT DOES NOT COVER
 * ======================
 * Whether a call site uses the DECISION. A route that calls canEditTrip and
 * ignores the result passes this check; the route tests are what catch that.
 * And it scans text: a policy call built with a computed name is invisible.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const SRC = join(ROOT, "src");

/** Trip route files: everything under src/routes named trip* plus the two plan routes. */
const ROUTE_FILE = /^src\/routes\/(trips?[A-Za-z-]*|routePlan|plan)\.ts$/;

const INLINE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'host includes', re: /\["owner",\s*"co_host"\]\.includes\(/ },
  { name: 'role !== owner', re: /\.role\s*!==\s*"owner"/ },
  { name: 'owner_id !== user.id', re: /owner_id\s*!==\s*user\.id/ },
  { name: 'owner_id === user.id', re: /owner_id\s*===\s*user\.id/ },
];

/**
 * SURVEYED 2026-09-12 after the first conversion pass (GET /trips/:tripId,
 * PATCH /trips/:tripId, invite, add member, approve/decline join request,
 * reservation gate and delete, Safe Return attach). Measured with THIS file's
 * own file set and patterns against the pre-conversion tree: 47 before the
 * pass, 38 after. (The header's "46" was a hand survey over fewer files; the
 * check's number is the one that counts, which is why it is recorded here
 * rather than there.) Counts may only go DOWN.
 */
const BASELINE: Record<string, number> = {
  "src/routes/trips-expansion.ts": 33,
  "src/routes/trips.ts": 4,
  // Found by this check's own file set on its first run — the hand survey that
  // produced the header's "46" had not looked here. Recorded, not exempted.
  "src/routes/tripBudgetIntel.ts": 1,
};

/**
 * The nine §6.1 names. Three are the spec's names for functions that predate
 * this module and are still called under their older names; the alias is the
 * name a call site may use instead.
 */
const POLICY_FUNCTIONS: Array<{ name: string; aliases: string[] }> = [
  { name: "canViewTrip", aliases: [] },
  { name: "canInviteParticipant", aliases: [] },
  { name: "canManageJoinRequests", aliases: [] },
  { name: "canEditTrip", aliases: [] },
  { name: "canCreatePlan", aliases: ["canEditPlan"] },
  { name: "canModifyPlan", aliases: ["canEditPlanItem"] },
  { name: "canManageBooking", aliases: [] },
  { name: "canSeePresence", aliases: [] },
  { name: "canSeePreciseLocation", aliases: ["resolveExactCoords"] },
  { name: "canManageSafety", aliases: [] },
];

const NOT_A_CALLER = new Set([
  "src/lib/tripPolicy.ts", "src/lib/tripPresencePolicy.ts", "src/lib/http.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "test" || name === "scripts" || name === "migrations") continue;
      walk(p, out);
    } else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((p) => ({ rel: relative(ROOT, p), text: readFileSync(p, "utf8") }));
if (files.length < 50) {
  console.log(`::error::checkTripPolicyCallsites read only ${files.length} source file(s); a check that scans nothing passes for the wrong reason.`);
  process.exit(1);
}

// ── 1. the ratchet ───────────────────────────────────────────────────────────
const counts = new Map<string, number>();
for (const f of files) {
  if (!ROUTE_FILE.test(f.rel)) continue;
  let n = 0;
  for (const line of f.text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    for (const p of INLINE_PATTERNS) if (p.re.test(line)) n += 1;
  }
  if (n > 0) counts.set(f.rel, n);
}

const problems: string[] = [];
for (const [file, n] of counts) {
  const base = BASELINE[file];
  if (base === undefined) {
    problems.push(`${file}: ${n} inline host/owner check(s) in a file NOT in the baseline. New authorization goes through lib/tripPolicy.ts (§6.1).`);
  } else if (n > base) {
    problems.push(`${file}: ${n} inline host/owner check(s), baseline ${base}. Legacy copies may only shrink.`);
  }
}
const shrank = [...Object.entries(BASELINE)].filter(([f, b]) => (counts.get(f) ?? 0) < b);

// ── 2. reachability ──────────────────────────────────────────────────────────
const unreached: string[] = [];
const callers = new Map<string, string[]>();
for (const fn of POLICY_FUNCTIONS) {
  const names = [fn.name, ...fn.aliases];
  const where: string[] = [];
  for (const f of files) {
    if (NOT_A_CALLER.has(f.rel)) continue;
    for (const line of f.text.split("\n")) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      if (names.some((n) => new RegExp(`\\b${n}\\(`).test(line))) { where.push(f.rel); break; }
    }
  }
  callers.set(fn.name, where);
  if (where.length === 0) unreached.push(fn.name);
}
if (unreached.length > 0) {
  problems.push(`§6.1 function(s) with NO call site outside lib/tripPolicy.ts: ${unreached.join(", ")}. A policy nobody calls is not a capability.`);
}

// ── report ───────────────────────────────────────────────────────────────────
const total = [...counts.values()].reduce((a, b) => a + b, 0);
const baseTotal = Object.values(BASELINE).reduce((a, b) => a + b, 0);
console.log(`check:trip-policy-callsites — ${total} inline host/owner check(s) remain across trip routes (baseline ${baseTotal}):`);
for (const [f, n] of [...counts.entries()].sort()) console.log(`  ${f.padEnd(40)} ${String(n).padStart(3)}  (baseline ${BASELINE[f] ?? "—"})`);
console.log(`§6.1 policy functions and where they are called:`);
for (const fn of POLICY_FUNCTIONS) {
  const w = callers.get(fn.name) ?? [];
  console.log(`  ${fn.name.padEnd(24)} ${String(w.length).padStart(2)} caller file(s)${fn.aliases.length ? ` (also as ${fn.aliases.join(", ")})` : ""}: ${w.join(", ")}`);
}
if (shrank.length > 0) {
  console.log(`\nratchet can be tightened — ${shrank.length} file(s) now carry FEWER inline checks than the baseline; lower BASELINE in this file:`);
  for (const [f, b] of shrank) console.log(`  ${f}: ${counts.get(f) ?? 0} (baseline ${b})`);
}
console.log("NOTE: DOES NOT COVER — (1) whether a call site USES the decision it asked for; the route tests do. (2) A policy call built with a computed name. (3) Inline checks in files outside src/routes/trip*, routePlan and plan. (4) An `owner_id === user.id` that picks a write path rather than authorizing: it is counted anyway, on purpose — see the header.");

if (problems.length > 0) {
  for (const p of problems) console.log(`::error::${p}`);
  console.log(`\ncheck:trip-policy-callsites FAILED — ${problems.length} problem(s).`);
  process.exit(1);
}
console.log("\ncheck:trip-policy-callsites PASSED");
