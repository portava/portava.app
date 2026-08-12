/**
 * auditFlagDrift — reconcile the feature_flags table against the migrations.
 *
 * WHY THIS EXISTS
 * ---------------
 * There are two populations of drift and they were being counted with two
 * different denominators, which made them look like one subtraction when they
 * are not:
 *
 *   LIVE, NEVER SEEDED   a row exists in production that no migration creates.
 *                        It got there by an admin toggle, a console insert or a
 *                        script, and the repository has no record it exists. A
 *                        restored environment simply will not have it.
 *
 *   SEEDED, NOT LIVE     a migration creates a flag that production does not
 *                        have. Either the migration never ran, or the row was
 *                        deleted afterwards.
 *
 * `168 live − 129 seeded = 39` is the wrong sum and does not equal either
 * population. 129 is a REPOSITORY count (distinct names in an
 * `INSERT INTO feature_flags` under src/migrations/); 168 and 49 are LIVE
 * counts. The identity that holds is `seeded∩live + live-only = live`.
 *
 * `check-flag-polarity.mjs` cannot answer either question: its rule R6 asks
 * whether every flag a migration SEEDS is read or declared inert, so a flag no
 * migration seeds passes it trivially — not because it is fine, but because it
 * is invisible to the question.
 *
 * WHY BOTH POPULATIONS IN ONE SCRIPT
 * ----------------------------------
 * Because they overlap, and reconciling them separately produces two different
 * answers to one decision. Production holds `location_intelligence_phase1..6`
 * (unseeded, all false, no reader); the migrations seed
 * `location_phase1_gps..phase6_crew` (absent from production, no reader). Two
 * six-flag families describing one rollout under two naming schemes, one on
 * each side of the drift. A script that reported only one side would invite
 * exactly the wrong remedy.
 *
 * READ-ONLY. One SELECT over public.feature_flags. It reports; it creates,
 * deletes and toggles nothing. Every remedy is a deliberate migration.
 *
 * EXIT CODES
 *   0  report produced (drift is reported, never a failure — this is a census)
 *   2  environment / API error — cannot run
 *
 * See src/lib/ciProdReadOnlyAuditGuard.mjs and docs/ci/BOOTSTRAP.md.
 */
import "../lib/ciProdReadOnlyAuditGuard.mjs";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SUPABASE_URL = process.env.SUPABASE_URL;
const ACCESS_TOKEN =
  process.env.SUPABASE_PROJECT_TOKEN || process.env.SUPABASE_ACCESS_TOKEN;

if (!SUPABASE_URL || !ACCESS_TOKEN) {
  console.error(
    "ERROR: SUPABASE_URL and a Supabase token must be set.\n" +
      "       Set SUPABASE_PROJECT_TOKEN or SUPABASE_ACCESS_TOKEN.",
  );
  process.exit(2);
}

const projectRef = new URL(SUPABASE_URL).hostname.split(".")[0];

async function liveQuery<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) throw new Error(`Management API ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

// ── The seeded population, from the migrations ───────────────────────────────
//
// Matcher deliberately identical to check-flag-polarity.mjs (its seeded-flag
// scan): scope to an `INSERT INTO feature_flags` statement, then take the
// leading quoted identifier of each row literal. Two different matchers would
// mean two different answers to "what does the repo seed", which is the whole
// disease being treated here.

const __dir = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dir, "../migrations");

const seeded = new Map<string, string>();
let migrationFiles = 0;
let seedStatements = 0;

for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) {
  migrationFiles++;
  const text = readFileSync(join(migrationsDir, f), "utf8");
  for (const m of text.matchAll(
    /INSERT\s+INTO\s+(?:[A-Za-z_][A-Za-z0-9_]*\.)?feature_flags\b/gi,
  )) {
    seedStatements++;
    const rest = text.slice(m.index);
    const semi = rest.indexOf(";");
    const stmt = semi > 0 ? rest.slice(0, semi) : rest;
    for (const row of stmt.matchAll(/\(\s*'([A-Za-z0-9_]+)'\s*,/g)) {
      if (!seeded.has(row[1])) seeded.set(row[1], f);
    }
  }
}

// VACUITY: a census whose subject is empty reports "no drift", which is the
// most comfortable possible wrong answer. Each of these means the scan broke.
if (migrationFiles === 0) {
  console.error("VACUOUS: zero .sql files under src/migrations.");
  process.exit(2);
}
if (seedStatements === 0) {
  console.error(
    "VACUOUS: no `INSERT INTO feature_flags` statement found. The seeding moved " +
      "or the matcher broke; both mean this census is reporting nothing.",
  );
  process.exit(2);
}
if (seeded.size === 0) {
  console.error("VACUOUS: no seeded flag names extracted — the row matcher is the likely cause.");
  process.exit(2);
}

// ── The live population ──────────────────────────────────────────────────────

interface LiveFlag { flag: string; enabled: boolean | null }
const live = await liveQuery<LiveFlag>(
  `select flag, enabled from feature_flags order by flag`,
);

if (live.length === 0) {
  console.error("VACUOUS: feature_flags returned zero rows. Refusing to report 49/10 against an empty table.");
  process.exit(2);
}

const liveByKey = new Map(live.map((r) => [r.flag, r.enabled]));

const liveNotSeeded = live.filter((r) => !seeded.has(r.flag));
const seededNotLive = [...seeded.entries()].filter(([k]) => !liveByKey.has(k));
const both = live.length - liveNotSeeded.length;

// ── Report ───────────────────────────────────────────────────────────────────

const line = "═".repeat(74);
console.log(line);
console.log("FEATURE FLAG DRIFT CENSUS");
console.log(line);
console.log(`  migrations scanned      : ${migrationFiles} file(s), ${seedStatements} INSERT statement(s)`);
console.log(`  seeded by a migration   : ${seeded.size}   (repository count)`);
console.log(`  live flags              : ${live.length}   (production count)`);
console.log(`  seeded AND live         : ${both}`);
console.log(`  LIVE, NEVER SEEDED      : ${liveNotSeeded.length}`);
console.log(`  SEEDED, NOT LIVE        : ${seededNotLive.length}`);
console.log(`\n  identity check: ${both} + ${liveNotSeeded.length} = ${both + liveNotSeeded.length} (live=${live.length})`);
if (both + liveNotSeeded.length !== live.length) {
  console.error("  ✗ identity does not hold — the two populations were computed inconsistently.");
  process.exit(2);
}

console.log(`\n${line}`);
console.log(`SEEDED, NOT LIVE — ${seededNotLive.length}`);
console.log(line);
console.log("  A migration creates these; production does not have them. Either the");
console.log("  migration never ran, or the row was deleted after it did.\n");
for (const [k, f] of seededNotLive.sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${k.padEnd(46)} seeded by ${f}`);
}

console.log(`\n${line}`);
console.log(`LIVE, NEVER SEEDED — ${liveNotSeeded.length}`);
console.log(line);
console.log("  In production, created by no migration. A restored environment gets");
console.log("  no row, and every one of these reads false through the fail-closed");
console.log("  helper.\n");
for (const r of liveNotSeeded) {
  console.log(`  ${r.flag.padEnd(46)} = ${String(r.enabled)}`);
}

// ── The overlapping families ─────────────────────────────────────────────────
//
// Named explicitly because this is the pair the ruling turns on: reconciling
// the two populations separately would produce two different answers for one
// rollout.

const LOCATION_RE = /^location_(intelligence_)?phase/i;
const liveLoc = liveNotSeeded.filter((r) => LOCATION_RE.test(r.flag)).map((r) => r.flag);
const seedLoc = seededNotLive.filter(([k]) => LOCATION_RE.test(k)).map(([k]) => k);

if (liveLoc.length > 0 || seedLoc.length > 0) {
  console.log(`\n${line}`);
  console.log("OVERLAPPING FAMILIES — one rollout, two naming schemes");
  console.log(line);
  console.log(`  live but unseeded  (${liveLoc.length}): ${liveLoc.join(", ") || "none"}`);
  console.log(`  seeded but absent  (${seedLoc.length}): ${seedLoc.join(", ") || "none"}`);
  console.log("\n  These describe the same rollout on opposite sides of the drift, and");
  console.log("  neither side is read by anything. They get ONE answer, not two.");
}

console.log(`\n${line}`);
console.log("Census only. No flag was created, deleted, toggled or seeded.");
console.log("Every remedy is a deliberate migration, decided per flag.");
process.exit(0);
